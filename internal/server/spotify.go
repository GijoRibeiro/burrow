package server

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

type nowPlaying struct {
	Available  bool   `json:"available"`
	Running    bool   `json:"running"`
	Playing    bool   `json:"playing"`
	Track      string `json:"track"`
	Artist     string `json:"artist"`
	Album      string `json:"album"`
	PositionMs int    `json:"positionMs"`
	DurationMs int    `json:"durationMs"`
	ArtworkURL string `json:"artworkUrl"`
	Source     string `json:"source"`
}

// Tab-delimited AppleScript output for both Spotify and Apple Music. Fields:
//   running | playing | track | artist | album | position(sec) | duration(ms) | artwork
// Notes:
//   - `running of application "X"` is safe: it reports state without launching.
//   - AppleScript does NOT interpret backslash escapes in quoted strings, so
//     tabs must be concatenated with the `tab` constant, not written as "\t".
//   - Avoid the identifier `st`; AppleScript treats it as part of a reserved
//     token and errors out.
//   - Apple Music's `duration of current track` is in SECONDS (not ms like
//     Spotify), so the script multiplies by 1000 to normalize.
//   - Apple Music has no `artwork url`, so its script returns an empty artwork
//     field. Frontend renders the placeholder in that case.

const spotifyScript = `
set emptyOut to "0" & tab & "0" & tab & "" & tab & "" & tab & "" & tab & "0" & tab & "0" & tab & ""
if running of application "Spotify" is false then return emptyOut
tell application "Spotify"
	set tr to ""
	set ar to ""
	set al to ""
	set pos to 0
	set dur to 0
	set art to ""
	set isPlaying to false
	try
		set playState to player state as string
		set isPlaying to (playState is equal to "playing")
	end try
	try
		set tr to name of current track
		set ar to artist of current track
		set al to album of current track
		set dur to duration of current track
		set art to artwork url of current track
	end try
	try
		set pos to player position
	end try
	return "1" & tab & isPlaying & tab & tr & tab & ar & tab & al & tab & pos & tab & dur & tab & art
end tell
`

const appleMusicScript = `
set emptyOut to "0" & tab & "0" & tab & "" & tab & "" & tab & "" & tab & "0" & tab & "0" & tab & ""
if running of application "Music" is false then return emptyOut
tell application "Music"
	set tr to ""
	set ar to ""
	set al to ""
	set pos to 0
	set dur to 0
	set isPlaying to false
	try
		set playState to player state as string
		set isPlaying to (playState is equal to "playing")
	end try
	try
		set tr to name of current track
		set ar to artist of current track
		set al to album of current track
		set dur to (duration of current track) * 1000
	end try
	try
		set pos to player position
	end try
	return "1" & tab & isPlaying & tab & tr & tab & ar & tab & al & tab & pos & tab & dur & tab & ""
end tell
`

func scriptFor(source string) string {
	if source == "apple-music" {
		return appleMusicScript
	}
	return spotifyScript
}

func appNameFor(source string) string {
	if source == "apple-music" {
		return "Music"
	}
	return "Spotify"
}

// query runs the script for one source and returns parsed NowPlaying.
func query(source string) (nowPlaying, error) {
	resp := nowPlaying{Available: true, Source: source}
	out, err := exec.Command("osascript", "-e", scriptFor(source)).Output()
	if err != nil {
		return resp, err
	}
	parts := strings.Split(strings.TrimSpace(string(out)), "\t")
	if len(parts) < 8 {
		return resp, nil
	}
	resp.Running = parts[0] == "1"
	resp.Playing = strings.EqualFold(parts[1], "true")
	resp.Track = parts[2]
	resp.Artist = parts[3]
	resp.Album = parts[4]
	posStr := strings.Replace(parts[5], ",", ".", 1)
	if posSec, err := strconv.ParseFloat(posStr, 64); err == nil {
		resp.PositionMs = int(posSec * 1000)
	}
	// Apple Music's duration may come back with a decimal (e.g., "225000.0").
	durStr := strings.Replace(parts[6], ",", ".", 1)
	if durF, err := strconv.ParseFloat(durStr, 64); err == nil {
		resp.DurationMs = int(durF)
	}
	resp.ArtworkURL = parts[7]
	return resp, nil
}

// pickAuto asks both sources and returns the one that's actively playing. If
// neither is playing but one is running, that one wins. Otherwise falls back
// to the Spotify response (even if empty) so the client sees a consistent shape.
func pickAuto() nowPlaying {
	sp, _ := query("spotify")
	am, _ := query("apple-music")
	if sp.Playing {
		return sp
	}
	if am.Playing {
		return am
	}
	if sp.Running {
		return sp
	}
	if am.Running {
		return am
	}
	return sp
}

func (s *Server) handleNowPlaying(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if runtime.GOOS != "darwin" {
		_ = json.NewEncoder(w).Encode(nowPlaying{Available: false})
		return
	}
	source := r.URL.Query().Get("source")
	var resp nowPlaying
	switch source {
	case "spotify", "apple-music":
		resp, _ = query(source)
	default:
		resp = pickAuto()
	}
	_ = json.NewEncoder(w).Encode(resp)
}

// handleSpotifyRequestAccess runs a harmless osascript against the configured
// music app that forces macOS to show the Automation consent prompt the first
// time. Wired to a "grant access" button in settings. Uses the `source` query
// param (default spotify) so users on Apple Music can trigger that prompt too.
func (s *Server) handleSpotifyRequestAccess(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "darwin" {
		http.Error(w, "music access is macOS only", http.StatusNotImplemented)
		return
	}
	source := r.URL.Query().Get("source")
	app := appNameFor(source)
	cmd := `tell application "` + app + `" to get name`
	if err := exec.Command("osascript", "-e", cmd).Run(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSpotifyControl(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "darwin" {
		http.Error(w, "music control is macOS only", http.StatusNotImplemented)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Action string `json:"action"`
		Source string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	// If no explicit source, route the command to whatever is currently
	// playing (or running). This way the user's prev/play/next buttons work
	// regardless of which app they're using.
	app := ""
	switch body.Source {
	case "spotify", "apple-music":
		app = appNameFor(body.Source)
	default:
		np := pickAuto()
		app = appNameFor(np.Source)
	}
	var cmd string
	switch body.Action {
	case "play-pause":
		cmd = `tell application "` + app + `" to playpause`
	case "next":
		cmd = `tell application "` + app + `" to next track`
	case "previous":
		cmd = `tell application "` + app + `" to previous track`
	default:
		http.Error(w, "unknown action", http.StatusBadRequest)
		return
	}
	if err := exec.Command("osascript", "-e", cmd).Run(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
