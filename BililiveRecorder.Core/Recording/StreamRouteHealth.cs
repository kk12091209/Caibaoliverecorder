using System;
using System.Collections.Generic;
using System.Linq;

namespace BililiveRecorder.Core.Recording
{
    // Process-local, bounded history. Never retain signed stream URLs or cookies.
    internal sealed class StreamRouteHealth
    {
        internal static readonly StreamRouteHealth Shared = new();
        private readonly object sync = new();
        private readonly Dictionary<string, DateTimeOffset> failures = new();
        internal string Select(int room, IEnumerable<string> hosts, DateTimeOffset now)
        {
            lock (this.sync)
            {
                foreach (var old in this.failures.Where(x => x.Value <= now).Select(x => x.Key).ToArray()) this.failures.Remove(old);
                return hosts.Distinct().OrderBy(host => this.failures.TryGetValue(room + ":" + host, out var until) && until > now ? 1 : 0)
                    .ThenBy(host => host.Contains(".mcdn.") ? 1 : 0)
                    .ThenBy(host => this.failures.TryGetValue(room + ":" + host, out var until) ? until : DateTimeOffset.MinValue).First();
            }
        }
        internal void Failed(int room, string host, DateTimeOffset now)
        {
            if (string.IsNullOrEmpty(host)) return;
            lock (this.sync)
            {
                if (this.failures.Count >= 512) this.failures.Remove(this.failures.OrderBy(x => x.Value).First().Key);
                this.failures[room + ":" + host] = now.AddMinutes(2);
            }
        }
    }
}
