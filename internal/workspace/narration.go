package workspace

import (
	"encoding/base64"
	"encoding/binary"
)

// Claude Code 2.1.274 stores its visible progress narration in thinking blocks.
// The signature envelope explicitly distinguishes "narration" from "thinking":
// envelope field 2 -> metadata field 1 -> kind field 8. Only this exact marker
// is eligible for the quiet chat. Missing, unknown, or malformed metadata stays
// hidden; never infer visibility from the prose or inspect encrypted payloads.
func isClaudeNarration(signature string) bool {
	if len(signature) == 0 || len(signature) > 64<<10 {
		return false
	}
	data, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return false
	}
	for _, field := range []uint64{2, 1, 8} {
		data = signatureBytesField(data, field)
		if data == nil {
			return false
		}
	}
	return string(data) == "narration"
}

// Read only the length-delimited metadata fields from the protobuf envelope.
func signatureBytesField(data []byte, wanted uint64) []byte {
	for len(data) > 0 {
		tag, n := binary.Uvarint(data)
		if n <= 0 || tag>>3 == 0 {
			return nil
		}
		data = data[n:]
		var size uint64
		switch tag & 7 {
		case 0:
			_, n = binary.Uvarint(data)
			if n <= 0 {
				return nil
			}
			size = uint64(n)
		case 1:
			size = 8
		case 2:
			size, n = binary.Uvarint(data)
			if n <= 0 {
				return nil
			}
			data = data[n:]
		case 5:
			size = 4
		default:
			return nil
		}
		if size > uint64(len(data)) {
			return nil
		}
		if tag>>3 == wanted {
			if tag&7 != 2 {
				return nil
			}
			return data[:int(size)]
		}
		data = data[int(size):]
	}
	return nil
}
