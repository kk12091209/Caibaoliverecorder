using System.Net;
using BililiveRecorder.Core.Api;
using BililiveRecorder.Web.Api;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using Xunit;

namespace BililiveRecorder.Web.Tests
{
    public class CredentialsControllerTests
    {
        private static CredentialsController Controller(bool enabled = true, string ip = "127.0.0.1", string origin = "", string password = "synthetic-core-password")
        {
            var context = new DefaultHttpContext();
            context.Connection.RemoteIpAddress = IPAddress.Parse(ip);
            if (origin.Length > 0) context.Request.Headers["Origin"] = origin;
            return new CredentialsController(new RuntimeCookie(enabled), new BasicAuthCredential("editor", password))
            { ControllerContext = new ControllerContext { HttpContext = context } };
        }
        [Fact]
        public void ResponseContainsStatusOnlyAndReplacementCannotBeReadBack()
        {
            var controller = Controller();
            controller.Set(new CredentialsController.CredentialInput { Cookie = "SESSDATA=first-synthetic" });
            controller.Set(new CredentialsController.CredentialInput { Cookie = "SESSDATA=second-synthetic" });
            var result = Assert.IsType<OkObjectResult>(controller.Status());
            var json = JsonConvert.SerializeObject(result.Value);
            Assert.Contains("\"configured\":true", json);
            Assert.DoesNotContain("synthetic", json);
            Assert.IsType<BadRequestObjectResult>(controller.Set(new CredentialsController.CredentialInput { Cookie = "x=y\r\nHeader: bad" }));
            controller.Set(new CredentialsController.CredentialInput { Cookie = string.Empty });
            Assert.Contains("\"configured\":false", JsonConvert.SerializeObject(Assert.IsType<OkObjectResult>(controller.Status()).Value));
        }
        [Theory]
        [InlineData(false, "127.0.0.1", "", "synthetic-core-password")]
        [InlineData(true, "192.0.2.2", "", "synthetic-core-password")]
        [InlineData(true, "127.0.0.1", "http://localhost", "synthetic-core-password")]
        [InlineData(true, "127.0.0.1", "", "short")]
        public void DisabledRemoteBrowserAndWeakAuthContextsCannotAccessCredentials(bool enabled, string ip, string origin, string password)
        {
            var controller = Controller(enabled, ip, origin, password);
            Assert.IsType<NotFoundResult>(controller.Status());
            Assert.IsType<NotFoundResult>(controller.Set(new CredentialsController.CredentialInput { Cookie = "x=synthetic" }));
        }
    }
}
