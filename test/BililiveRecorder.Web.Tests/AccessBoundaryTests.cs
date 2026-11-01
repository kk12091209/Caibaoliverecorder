using System;
using System.IO;
using System.Threading.Tasks;
using AutoMapper;
using BililiveRecorder.Core.Config.V3;
using BililiveRecorder.Web;
using BililiveRecorder.Web.Models;
using BililiveRecorder.Web.Models.Rest;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Newtonsoft.Json;
using Xunit;

public class AccessBoundaryTests
{
    [Theory]
    [InlineData(null, 204)]
    [InlineData("http://127.0.0.1:8000", 204)]
    [InlineData("http://127.0.0.1:8001", 403)]
    [InlineData("https://malicious.example", 403)]
    [InlineData("null", 403)]
    public async Task OnlySameOriginOrNativeClientsReachAuthenticatedHandler(string origin, int expected)
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "http"; context.Request.Host = new HostString("127.0.0.1", 8000);
        if (origin != null) context.Request.Headers["Origin"] = origin;
        await new SameOriginMiddleware(ctx => { ctx.Response.StatusCode = 204; return Task.CompletedTask; }).InvokeAsync(context);
        Assert.Equal(expected, context.Response.StatusCode);
    }

    [Fact]
    public async Task MissingCredentialsNeverExposeHandler()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString()); Directory.CreateDirectory(root);
        try {
            File.WriteAllText(Path.Combine(root, "401.html"), "unauthorized");
            using var provider = new PhysicalFileProvider(root); var files = new CompositeFileProvider(provider);
            using var services = new ServiceCollection().BuildServiceProvider();
            var context = new DefaultHttpContext { RequestServices = services };
            await new BasicAuthMiddleware(_ => throw new Exception("data exposed"), files).InvokeAsync(context);
            Assert.Equal(401, context.Response.StatusCode);
        } finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void ConfigWritesPreserveSecretsWithoutReturningThem()
    {
        var config = new GlobalConfig();
        JsonConvert.DeserializeObject<SetGlobalConfig>("{\"optionalCookie\":{\"hasValue\":true,\"value\":\"SECRET_COOKIE\"}}")?.ApplyTo(config);
        config.Cookie = "SECRET_COOKIE"; config.WebHookUrls = "https://example.com/?token=SECRET_HOOK";
        var mapper = new MapperConfiguration(c => c.AddProfile<DataMappingProfile>()).CreateMapper();
        var output = JsonConvert.SerializeObject(mapper.Map<GlobalConfigDto>(config));
        Assert.DoesNotContain("SECRET", output); Assert.DoesNotContain("OptionalCookie", output); Assert.DoesNotContain("OptionalWebHook", output);
        new SetGlobalConfig().ApplyTo(config); Assert.Equal("SECRET_COOKIE", config.Cookie);
        Assert.NotNull(typeof(SetGlobalConfig).GetProperty("OptionalCookie"));
    }
    [Fact]
    public void FileBrowserHidesConfigurationBackupsLogsAndLinksButKeepsMedia()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString()); Directory.CreateDirectory(root);
        try {
            foreach (var name in new[] { "config.json", "config.backup.json", "config.abc123.json", "custom-config.yml", "log.txt", "record.flv", "record.xml" }) File.WriteAllText(Path.Combine(root, name), "sentinel");
            using var provider = new RecordingFileProvider(root);
            foreach (var name in new[] { "config.json", "config.backup.json", "config.abc123.json", "custom-config.yml", "log.txt" }) Assert.False(provider.GetFileInfo(name).Exists);
            Assert.True(provider.GetFileInfo("record.flv").Exists); Assert.True(provider.GetFileInfo("record.xml").Exists);
            Assert.Equal(2, System.Linq.Enumerable.Count(provider.GetDirectoryContents("/")));
            if (!OperatingSystem.IsWindows()) { File.CreateSymbolicLink(Path.Combine(root, "linked.flv"), Path.Combine(root, "config.json")); Assert.False(provider.GetFileInfo("linked.flv").Exists); }
        } finally { Directory.Delete(root, true); }
    }
}
