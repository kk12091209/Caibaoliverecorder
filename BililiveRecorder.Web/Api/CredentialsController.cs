using System;
using System.Net;
using BililiveRecorder.Core.Api;
using Microsoft.AspNetCore.Mvc;

namespace BililiveRecorder.Web.Api
{
    [ApiController, Route("api/credentials")]
    public sealed class CredentialsController : ControllerBase
    {
        private readonly RuntimeCookie credentials;
        private readonly BasicAuthCredential? authentication;
        public CredentialsController(RuntimeCookie credentials, BasicAuthCredential? authentication = null)
        { this.credentials = credentials; this.authentication = authentication; }
        private bool Allowed => this.credentials.Enabled && this.authentication?.Password.Length >= 16 &&
            this.HttpContext.Connection.RemoteIpAddress is { } ip && IPAddress.IsLoopback(ip) &&
            string.IsNullOrEmpty(this.Request.Headers["Origin"]);
        [HttpGet("cookie")]
        public IActionResult Status() => !this.Allowed ? this.NotFound() : this.Ok(new { supported = true, configured = this.credentials.Configured });
        public sealed class CredentialInput { public string? Cookie { get; set; } }
        [HttpPost("cookie"), RequestSizeLimit(65536)]
        public IActionResult Set([FromBody] CredentialInput input)
        {
            if (!this.Allowed) return this.NotFound();
            try { this.credentials.Set(input.Cookie ?? throw new ArgumentException()); }
            catch (ArgumentException) { return this.BadRequest(new { error = "Invalid credential" }); }
            // No echo, no persistence, no config mapper, no log statement.
            return this.Ok(new { supported = true, configured = this.credentials.Configured });
        }
    }
}
