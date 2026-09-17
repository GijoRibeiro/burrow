package workspace

import (
	"bufio"
	"io"
	"os"
	"sync"
)

// Index human-facing records once, then read only appended bytes. Tool output
// may be enormous, but must never evict a conversation message from the chat.
// Raw records (including tool payloads and private reasoning) are not cached.
type conversationReader struct {
	mu     sync.Mutex
	path   string
	file   os.FileInfo
	offset int64
	log    conversationLog
}

func (m *Manager) readConversation(id, path string) (Activity, error) {
	value, _ := m.conversations.LoadOrStore(id, &conversationReader{})
	reader := value.(*conversationReader)
	reader.mu.Lock()
	defer reader.mu.Unlock()
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
	}
	reader.file = info
	if _, err = file.Seek(reader.offset, io.SeekStart); err != nil {
		return Activity{}, err
	}
	// A busy writer cannot extend this poll indefinitely. A partial last record
	// is reread next time, without advancing the committed offset or dropping text.
	records := bufio.NewReader(io.LimitReader(file, info.Size()-reader.offset))
	for {
		line, readErr := records.ReadBytes('\n')
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return Activity{}, readErr
		}
		reader.log.consume(line)
		reader.offset += int64(len(line))
	}
	result := reader.log.activity
	result.Messages = append([]ConversationMessage{}, result.Messages...)
	return result, nil
}
