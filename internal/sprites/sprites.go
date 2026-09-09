// Package sprites defines 1-bit creature pixel data and renders them
// as half-block Unicode characters for terminal display.
package sprites

// Creature holds a creature's name and pixel frames.
type Creature struct {
	Name   string
	Frames [][]string // each frame is a grid of "0"/"1" strings rendered to half-blocks
}

// A 16x16 grid where 1 = white pixel, 0 = black pixel.
// Each frame is stored as 16 strings of 16 chars ("0" or "1").
type PixelGrid [16]string

// RenderHalfBlocks converts a 16x16 pixel grid to an 8-line string
// using Unicode half-block characters. Each character cell encodes
// two vertical pixels:
//
//	▀ = top white, bottom black
//	▄ = top black, bottom white
//	█ = both white
//	  = both black (space)
func RenderHalfBlocks(grid PixelGrid) []string {
	lines := make([]string, 8)
	for row := 0; row < 8; row++ {
		topRow := grid[row*2]
		botRow := grid[row*2+1]
		line := make([]rune, 16)
		for col := 0; col < 16; col++ {
			top := topRow[col] == '1'
			bot := botRow[col] == '1'
			switch {
			case top && bot:
				line[col] = '█'
			case top && !bot:
				line[col] = '▀'
			case !top && bot:
				line[col] = '▄'
			default:
				line[col] = ' '
			}
		}
		lines[row] = string(line)
	}
	return lines
}

// DitherBorder returns a string of dithered characters for a border line.
// Uses alternating ▓░ pattern for the retro dither effect.
func DitherBorder(width int, offset int) string {
	line := make([]rune, width)
	for i := 0; i < width; i++ {
		if (i+offset)%2 == 0 {
			line[i] = '░'
		} else {
			line[i] = '▓'
		}
	}
	return string(line)
}

// Beholder creature - the one-eyed monster with horns
var Beholder = Creature{
	Name: "Beholder",
	Frames: pixelGridsToFrames(
		// Frame 1
		PixelGrid{
			"0000011001100000",
			"0000011001100000",
			"0000011111100000",
			"0000110000110000",
			"0001100000011000",
			"0001000111101000",
			"0001001001011000",
			"0001001100011000",
			"0001001100011000",
			"0001001001011000",
			"0001000111101000",
			"0001100000011000",
			"0000110000110000",
			"0000011111100000",
			"0000000000000000",
			"0000000000000000",
		},
		// Frame 2 (shifted down 1px)
		PixelGrid{
			"0000000000000000",
			"0000011001100000",
			"0000011001100000",
			"0000011111100000",
			"0000110000110000",
			"0001100000011000",
			"0001000111101000",
			"0001001001011000",
			"0001001100011000",
			"0001001100011000",
			"0001001001011000",
			"0001000111101000",
			"0001100000011000",
			"0000110000110000",
			"0000011111100000",
			"0000000000000000",
		},
	),
}

// Ghost creature
var Ghost = Creature{
	Name: "Ghost",
	Frames: pixelGridsToFrames(
		PixelGrid{
			"0000001111000000",
			"0000011111100000",
			"0000111111110000",
			"0000111111110000",
			"0000101101110000",
			"0000101101110000",
			"0000111111110000",
			"0000111111110000",
			"0000111111110000",
			"0000111111110000",
			"0000111111110000",
			"0000111111110000",
			"0000101101110000",
			"0000100010010000",
			"0000000000000000",
			"0000000000000000",
		},
		PixelGrid{
			"0000000000000000",
			"0000001111000000",
			"0000011111100000",
			"0000111111110000",
			"0000111111110000",
			"0000101101110000",
			"0000101101110000",
			"0000111111110000",
			"0000111111110000",
			"0000111111110000",
			"0000111111110000",
			"0000111111110000",
			"0000111111110000",
			"0000011001100000",
			"0000010000100000",
			"0000000000000000",
		},
	),
}

// Cat creature
var Cat = Creature{
	Name: "Cat",
	Frames: pixelGridsToFrames(
		PixelGrid{
			"0000000000000000",
			"0000100000010000",
			"0000110000110000",
			"0000111001110000",
			"0000111111110000",
			"0000111111110000",
			"0000010110100000",
			"0000111111110000",
			"0000011111100000",
			"0010011111101000",
			"0011111111111100",
			"0000011111100000",
			"0000011001100000",
			"0000011001100000",
			"0000000000000000",
			"0000000000000000",
		},
		PixelGrid{
			"0000000000000000",
			"0000100000010000",
			"0001100000011000",
			"0000111001110000",
			"0000111111110000",
			"0000111111110000",
			"0000010110100000",
			"0000111111110000",
			"0000011111100000",
			"0100011111100100",
			"0011111111111100",
			"0000011111100000",
			"0000011001100000",
			"0000011001100000",
			"0000000000000000",
			"0000000000000000",
		},
	),
}

// Skull creature
var Skull = Creature{
	Name: "Skull",
	Frames: pixelGridsToFrames(
		PixelGrid{
			"0000000000000000",
			"0000011111100000",
			"0000111111110000",
			"0000111111110000",
			"0000110010110000",
			"0000110010110000",
			"0000111111110000",
			"0000011111100000",
			"0000010101100000",
			"0000001111000000",
			"0000000000000000",
			"0011111111111100",
			"0001000110001000",
			"0010000000000100",
			"0000000000000000",
			"0000000000000000",
		},
		PixelGrid{
			"0000000000000000",
			"0000011111100000",
			"0000111111110000",
			"0000111111110000",
			"0000110010110000",
			"0000110010110000",
			"0000111111110000",
			"0000011111100000",
			"0000001101100000",
			"0000001111000000",
			"0000000000000000",
			"0011111111111100",
			"0000100110010000",
			"0001000000001000",
			"0000000000000000",
			"0000000000000000",
		},
	),
}

// Blob creature - one-eyed blob
var Blob = Creature{
	Name: "Blob",
	Frames: pixelGridsToFrames(
		PixelGrid{
			"0000000000000000",
			"0000000000000000",
			"0000000000000000",
			"0000001111000000",
			"0000011111100000",
			"0000111111110000",
			"0000111001110000",
			"0000110001110000",
			"0000111111110000",
			"0001111111111000",
			"0001111111111000",
			"0000111111110000",
			"0000011111100000",
			"0000000000000000",
			"0000000000000000",
			"0000000000000000",
		},
		PixelGrid{
			"0000000000000000",
			"0000000000000000",
			"0000000000000000",
			"0000000000000000",
			"0000001111000000",
			"0000011111100000",
			"0000111001110000",
			"0000110001110000",
			"0001111111111000",
			"0001111111111000",
			"0011111111111100",
			"0001111111111000",
			"0000111111110000",
			"0000000000000000",
			"0000000000000000",
			"0000000000000000",
		},
	),
}

// AllCreatures is the full roster.
var AllCreatures = []Creature{Beholder, Ghost, Cat, Skull, Blob}

func pixelGridsToFrames(grids ...PixelGrid) [][]string {
	frames := make([][]string, len(grids))
	for i, g := range grids {
		frames[i] = RenderHalfBlocks(g)
	}
	return frames
}
