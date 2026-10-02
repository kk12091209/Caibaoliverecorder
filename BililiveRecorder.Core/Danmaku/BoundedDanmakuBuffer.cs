using System;
using System.Collections.Generic;
using System.Linq;

namespace BililiveRecorder.Core.Danmaku
{
    // Non-generic so all rooms and payload types share the same process budget.
    internal static class DanmakuBufferBudget
    {
        internal static readonly object Gate = new object();
        internal static long Bytes;
    }

    internal sealed class BoundedDanmakuBuffer<T>
    {
        private const int PerSecond = 50, MaxMessages = 2000, MaxMessageBytes = 16 * 1024;
        private const long MaxRoomBytes = 8 * 1024 * 1024, MaxProcessBytes = 32 * 1024 * 1024;
        private readonly SortedDictionary<long, Window> windows = new SortedDictionary<long, Window>();
        private readonly Random random = new Random();
        private long bytes;
        private int count, generation;
        private bool accepting;

        private sealed class Entry
        {
            internal T Item = default!;
            internal int Bytes;
            internal bool Comment;
        }
        private sealed class Window
        {
            internal long Seen, Comments;
            internal readonly List<Entry> Items = new List<Entry>();
        }
        internal sealed class DensityPoint
        {
            internal long Second, Count;
            internal int Kept;
        }
        internal sealed class Batch : IDisposable
        {
            internal readonly List<T> Items;
            internal readonly List<DensityPoint> Density;
            private Action? release;
            internal Batch(List<T> items, List<DensityPoint> density, Action release)
            { this.Items = items; this.Density = density; this.release = release; }
            public void Dispose()
            {
                lock (DanmakuBufferBudget.Gate)
                {
                    if (this.release is null) return;
                    this.release(); this.release = null;
                    this.Items.Clear(); this.Density.Clear();
                }
            }
        }

        internal int Begin()
        {
            lock (DanmakuBufferBudget.Gate)
            {
                this.Clear(); this.accepting = true;
                return ++this.generation;
            }
        }
        internal void End() { lock (DanmakuBufferBudget.Gate) this.accepting = false; }
        internal void Clear()
        {
            lock (DanmakuBufferBudget.Gate)
            {
                foreach (var window in this.windows.Values)
                    foreach (var item in window.Items) this.Release(item.Bytes, 1);
                this.windows.Clear();
            }
        }
        private void Release(long size, int messages)
        { this.bytes -= size; this.count -= messages; DanmakuBufferBudget.Bytes -= size; }

        internal bool Add(T item, int retainedBytes, long second, int receiptGeneration, bool comment)
        {
            lock (DanmakuBufferBudget.Gate)
            {
                if (!this.accepting || receiptGeneration != this.generation || second < 0 || retainedBytes < 1 || retainedBytes > MaxMessageBytes) return false;
                if (!this.windows.TryGetValue(second, out var window))
                {
                    if (this.windows.Count >= MaxMessages) return false;
                    this.windows.Add(second, window = new Window());
                }
                window.Seen++;
                if (comment) window.Comments++;
                var index = window.Items.Count < PerSecond ? window.Items.Count : (long)(this.random.NextDouble() * window.Seen);
                if (index >= PerSecond) return false;
                var previous = index < window.Items.Count ? window.Items[(int)index] : null;
                var delta = retainedBytes - (previous?.Bytes ?? 0);
                if ((previous is null && this.count >= MaxMessages) || this.bytes + delta > MaxRoomBytes || DanmakuBufferBudget.Bytes + delta > MaxProcessBytes) return false;
                var entry = new Entry { Item = item, Bytes = retainedBytes, Comment = comment };
                if (previous is null) { window.Items.Add(entry); this.count++; }
                else window.Items[(int)index] = entry;
                this.bytes += delta; DanmakuBufferBudget.Bytes += delta;
                return true;
            }
        }
        internal Batch Take(long second, bool force)
        {
            lock (DanmakuBufferBudget.Gate)
            {
                var items = new List<T>(); var density = new List<DensityPoint>();
                long heldBytes = 0;
                foreach (var pair in this.windows.ToArray())
                {
                    if ((!force && pair.Key >= second) || (!force && (items.Count + pair.Value.Items.Count > 250 || density.Count >= 250))) break;
                    var window = pair.Value;
                    this.windows.Remove(pair.Key);
                    density.Add(new DensityPoint { Second = pair.Key, Count = window.Comments, Kept = window.Items.Count(entry => entry.Comment) });
                    foreach (var entry in window.Items) { items.Add(entry.Item); heldBytes += entry.Bytes; }
                }
                var heldCount = items.Count;
                // A stalled disk retains its full budget until the writer disposes the batch.
                return new Batch(items, density, () => this.Release(heldBytes, heldCount));
            }
        }
    }
}
