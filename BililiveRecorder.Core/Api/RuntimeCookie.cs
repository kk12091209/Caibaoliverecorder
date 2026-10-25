using System;
using System.Threading;

namespace BililiveRecorder.Core.Api
{
    // Desktop credentials are an in-memory override, never a Config property.
    // The opt-in mode also prevents sending them to a custom API host.
    public sealed class RuntimeCookie
    {
        private string value = string.Empty;
        public RuntimeCookie() : this(Environment.GetEnvironmentVariable("BREC_EPHEMERAL_AUTH") == "1") { }
        public RuntimeCookie(bool enabled) { this.Enabled = enabled; }
        public bool Enabled { get; }
        internal string Value => Volatile.Read(ref this.value);
        public bool Configured => this.Value.Length != 0;
        public event EventHandler? Changed;
        public void Set(string cookie)
        {
            if (!this.Enabled) throw new InvalidOperationException("Runtime credentials disabled");
            if (cookie is null || cookie.Length > 32768) throw new ArgumentException("Invalid credential");
            foreach (var c in cookie) if (c < 32 || c > 126) throw new ArgumentException("Invalid credential");
            if (Interlocked.Exchange(ref this.value, cookie) != cookie) this.Changed?.Invoke(this, EventArgs.Empty);
        }
    }
}
