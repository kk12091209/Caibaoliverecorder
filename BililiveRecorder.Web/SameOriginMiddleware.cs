using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace BililiveRecorder.Web
{
    public sealed class SameOriginMiddleware
    {
        private readonly RequestDelegate next;
        public SameOriginMiddleware(RequestDelegate next) => this.next = next;
        public Task InvokeAsync(HttpContext context)
        {
            var origin = context.Request.Headers["Origin"];
            if (origin.Count > 0 && (origin.Count != 1 ||
                !string.Equals(origin[0], context.Request.Scheme + "://" + context.Request.Host.Value, StringComparison.Ordinal)))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return Task.CompletedTask;
            }
            return this.next(context);
        }
    }
}
