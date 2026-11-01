using System;
using BililiveRecorder.Core.Api;
using BililiveRecorder.Core.Api.Model;
using BililiveRecorder.Core.Config;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Danmaku
{
    public class DanmakuServerSelectionTests
    {
        [Theory]
        [InlineData(DanmakuTransportMode.Tcp, 2243)]
        [InlineData(DanmakuTransportMode.Ws, 2244)]
        [InlineData(DanmakuTransportMode.Wss, 443)]
        public void EmptyListRetainsTransportAndToken(DanmakuTransportMode mode, int port)
        {
            var info = new DanmuInfo { HostList = Array.Empty<DanmuInfo.HostListItem>(), Token = "fixture-token" };
            for (int n = 0; n < 30; n++)
            {
                var server = info.SelectDanmakuServer(mode);
                Assert.Equal(mode, server.TransportMode);
                Assert.Equal(port, server.Port);
                Assert.Equal("fixture-token", server.Token);
            }
        }
        [Fact]
        public void UnusableServersAndDefaultHostStillUseAuthenticatedWss()
        {
            foreach (var host in new[] { "", "broadcastlv.chat.bilibili.com", "fixture.invalid" })
            {
                var info = new DanmuInfo { HostList = new[] { new DanmuInfo.HostListItem { Host = host, Port = 2243, WsPort = 2244, WssPort = 0 } }, Token = "new-token" };
                var server = info.SelectDanmakuServer(DanmakuTransportMode.Wss);
                Assert.Equal(DanmakuTransportMode.Wss, server.TransportMode);
                Assert.Equal("new-token", server.Token);
            }
        }
        [Fact]
        public void RandomAndMissingTokenPreserveTheRequestedContract()
        {
            var info = new DanmuInfo { HostList = Array.Empty<DanmuInfo.HostListItem>(), Token = "" };
            var server = info.SelectDanmakuServer(DanmakuTransportMode.Random);
            Assert.Contains(server.TransportMode, new[] { DanmakuTransportMode.Tcp, DanmakuTransportMode.Ws, DanmakuTransportMode.Wss });
            Assert.Equal("", server.Token);
            Assert.Throws<InvalidOperationException>(() => info.SelectDanmakuServer((DanmakuTransportMode)999));
        }
    }
}
