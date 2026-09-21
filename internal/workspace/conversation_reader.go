package workspace

import (
	"bufio"
	"errors"
	"io"
	"os"
	"sync"
)

const conversationPageSize = 60
const conversationPageBytes = 256 << 10
const conversationCacheBytes = 2 << 20

type conversationQuery struct {
	Before, After *int
	Session       string
	Limit         int
}
type conversationRecord struct {
	offset int64
	size   int
	id     string
}

// Keep file offsets, not days of hydrated message bodies. The transcript remains
// authoritative; a bounded cache serves active pages and old pages seek directly
// to their public records. Tool output and private reasoning are never cached.
type conversationReader struct {
	mu         sync.Mutex
	path       string
	file       os.FileInfo
	offset     int64
	log        conversationLog
	session    string
	records    []conversationRecord
	cache      map[int]ConversationMessage
	cacheBytes int
}

func (r *conversationReader) remember(index int, message ConversationMessage) {
	if old, ok := r.cache[index]; ok {
		r.cacheBytes -= len(old.Text)
		delete(r.cache, index)
	}
	if len(message.Text) > conversationCacheBytes {
		return
	}
	if len(r.cache) >= 2*conversationPageSize || r.cacheBytes+len(message.Text) > conversationCacheBytes {
		r.cache = map[int]ConversationMessage{}
		r.cacheBytes = 0
	}
	r.cache[index] = message
	r.cacheBytes += len(message.Text)
}

// Used by parser regressions; production requests always use a bounded page.
func (m *Manager) readConversation(terminalID, path string) (Activity, error) {
	return m.readConversationPage(terminalID, path, conversationQuery{})
}
func (m *Manager) readConversationPage(terminalID, path string, query conversationQuery) (Activity, error) {
	value, _ := m.conversations.LoadOrStore(terminalID, &conversationReader{})
	reader := value.(*conversationReader)
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if path == "" {
		path = reader.path
	}
	file, err := os.Open(path)
	if err != nil {
		return Activity{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Activity{}, err
	}
	if reader.path != path || reader.file == nil || !os.SameFile(reader.file, info) || info.Size() < reader.offset || (info.Size() == reader.offset && !info.ModTime().Equal(reader.file.ModTime())) {
		reader.path = path
		reader.offset = 0
		reader.log = newConversationLog()
		reader.session = id()
		reader.records = nil
		reader.cache = map[int]ConversationMessage{}
		reader.cacheBytes = 0
	}
	reader.file = info
	if _, err = file.Seek(reader.offset, io.SeekStart); err != nil {
		return Activity{}, err
	}
	var recordSize int
	reader.log.emit = func(message ConversationMessage, index int) {
		record := conversationRecord{reader.offset, recordSize, message.ID}
		if index == len(reader.records) {
			reader.records = append(reader.records, record)
		} else {
			reader.records[index] = record
		}
		reader.remember(index, message)
	}
	// A busy writer cannot extend a poll indefinitely; incomplete records are
	// retried next time without blanking history or advancing the committed offset.
	records := bufio.NewReader(io.LimitReader(file, info.Size()-reader.offset))
	for {
		line, readErr := records.ReadBytes('\n')
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return Activity{}, readErr
		}
		recordSize = len(line)
		reader.log.consume(line)
		reader.offset += int64(len(line))
	}
	reader.log.emit = nil
	result := reader.log.activity
	result.Messages = []ConversationMessage{}
	total := len(reader.records)
	start, end := 0, total
	forward := false
	if query.Limit > 0 {
		// A rotated/replaced session invalidates old cursors. Return its latest page.
		if query.Session == "" || query.Session == reader.session {
			if query.Before != nil {
				end = min(total, max(0, *query.Before))
			}
			if query.After != nil {
				start = min(total, max(0, *query.After))
				end = min(total, start+query.Limit)
				forward = true
			}
		}
		if !forward {
			start = max(0, end-query.Limit)
		}
	}
	readMessage := func(index int) (ConversationMessage, error) {
		if message, ok := reader.cache[index]; ok {
			return message, nil
		}
		record := reader.records[index]
		data := make([]byte, record.size)
		if _, err := file.ReadAt(data, record.offset); err != nil {
			return ConversationMessage{}, err
		}
		parsed := parseConversation(data)
		if len(parsed.Messages) != 1 {
			return ConversationMessage{}, errors.New("conversation changed while reading history")
		}
		message := parsed.Messages[0]
		message.ID = record.id
		reader.remember(index, message)
		return message, nil
	}
	used := 0
	// Enforce both message and text budgets, without splitting or losing a turn.
	// One individually oversized message is allowed so it remains accessible.
	if forward || query.Limit == 0 {
		for index := start; index < end; index++ {
			message, err := readMessage(index)
			if err != nil {
				return Activity{}, err
			}
			if query.Limit > 0 && used > 0 && used+len(message.Text) > conversationPageBytes {
				end = index
				break
			}
			result.Messages = append(result.Messages, message)
			used += len(message.Text)
		}
	} else {
		for index := end - 1; index >= start; index-- {
			message, err := readMessage(index)
			if err != nil {
				return Activity{}, err
			}
			if used > 0 && used+len(message.Text) > conversationPageBytes {
				start = index + 1
				break
			}
			result.Messages = append(result.Messages, message)
			used += len(message.Text)
		}
		for left, right := 0, len(result.Messages)-1; left < right; left, right = left+1, right-1 {
			result.Messages[left], result.Messages[right] = result.Messages[right], result.Messages[left]
		}
	}
	if query.Limit > 0 {
		result.History = &ConversationPage{reader.session, start, end, total}
	}
	return result, nil
}
