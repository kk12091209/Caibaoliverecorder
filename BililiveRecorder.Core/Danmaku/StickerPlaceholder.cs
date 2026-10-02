using System;

namespace BililiveRecorder.Core.Danmaku
{
    // Keep this conservative shape check aligned with live-editor/server/chat-filter.js.
    internal static class StickerPlaceholder
    {
        internal static bool IsMatch(string? text)
        {
            if (string.IsNullOrEmpty(text) || text!.Length > 2048 || text.IndexOfAny(new[] { '\r', '\n', '\v', '\f', '\u0085', '\u2028', '\u2029' }) >= 0) return false;
            var offset = 0;
            var count = 0;
            while (offset < text.Length)
            {
                while (offset < text.Length && char.IsWhiteSpace(text[offset])) offset++;
                if (offset == text.Length) break;
                if (text[offset] != '[') return false;
                var end = text.IndexOf(']', offset + 1);
                if (end < 0 || end - offset + 1 > 256) return false;
                var token = text.Substring(offset + 1, end - offset - 1);
                var marker = token.LastIndexOf("表情包_", StringComparison.Ordinal);
                if (token.IndexOf('[') >= 0 || marker <= 0 || string.IsNullOrWhiteSpace(token.Substring(0, marker)) || string.IsNullOrWhiteSpace(token.Substring(marker + 4))) return false;
                count++;
                offset = end + 1;
            }
            return count > 0;
        }
    }
}
