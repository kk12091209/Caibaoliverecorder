using System;
using BililiveRecorder.Core.Api;
using BililiveRecorder.Core.Api.Http;
using BililiveRecorder.Core.Config.V3;
using Newtonsoft.Json;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Api
{
    public class RuntimeCookieTests
    {
        [Fact]
        public void DesktopCredentialsOverrideMemoryOnlyAndClearWithoutReadingLegacyConfig()
        {
            var config = new GlobalConfig();
            config.Cookie = "SESSDATA=legacy-fixture; DedeUserID=999";
            var runtime = new RuntimeCookie(true);
            using var api = new HttpApiClient(config, runtime);
            Assert.Equal(0, api.GetUid());
            var changes = 0;
            runtime.Changed += (_, _) => changes++;
            const string first = "SESSDATA=synthetic-first; DedeUserID=123; buvid3=synthetic-buvid";
            runtime.Set(first);
            runtime.Set(first);
            Assert.Equal(1, changes);
            Assert.Equal(123, api.GetUid());
            Assert.Equal("synthetic-buvid", api.GetBuvid3());
            Assert.DoesNotContain("synthetic-first", JsonConvert.SerializeObject(config));
            Assert.DoesNotContain("synthetic-first", JsonConvert.SerializeObject(runtime));
            runtime.Set("SESSDATA=synthetic-second; DedeUserID=456");
            Assert.Equal(456, api.GetUid());
            runtime.Set(string.Empty);
            Assert.False(runtime.Configured);
            Assert.Equal(0, api.GetUid());
        }
        [Fact]
        public void DisabledModeRetainsLegacyBehaviorAndCannotSetDesktopCredential()
        {
            var config = new GlobalConfig();
            config.Cookie = "SESSDATA=legacy-fixture; DedeUserID=999";
            var runtime = new RuntimeCookie(false);
            using var api = new HttpApiClient(config, runtime);
            Assert.Equal(999, api.GetUid());
            Assert.Throws<InvalidOperationException>(() => runtime.Set("cookie=value"));
        }
        [Theory]
        [InlineData("x=y\r\nX-Test: header")]
        [InlineData("x=y\0")]
        [InlineData("x=中文")]
        public void InvalidHeadersNeverReplaceThePreviousCredential(string input)
        {
            var runtime = new RuntimeCookie(true);
            runtime.Set("x=previous");
            Assert.Throws<ArgumentException>(() => runtime.Set(input));
            Assert.Equal("x=previous", runtime.Value);
            Assert.Throws<ArgumentException>(() => runtime.Set(new string('x', 32769)));
        }
    }
}
