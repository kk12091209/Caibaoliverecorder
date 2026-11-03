using System;
using BililiveRecorder.Core.Recording;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Recording
{
    public class StreamRouteHealthTests
    {
        [Fact]
        public void PreferHealthyRoutesThenRecoverExpiredFailuresWithoutCrossRoomPenalty()
        {
            var health = new StreamRouteHealth(); var now = DateTimeOffset.UtcNow;
            var hosts = new[] { "https://first.example/", "https://second.example/", "https://fallback.mcdn.example/" };
            Assert.Equal(hosts[0], health.Select(1, hosts, now));
            health.Failed(1, hosts[0], now);
            Assert.Equal(hosts[1], health.Select(1, hosts, now));
            Assert.Equal(hosts[0], health.Select(2, hosts, now));
            health.Failed(1, hosts[1], now.AddSeconds(1));
            Assert.Equal(hosts[2], health.Select(1, hosts, now.AddSeconds(2)));
            health.Failed(1, hosts[2], now.AddSeconds(3));
            Assert.Equal(hosts[0], health.Select(1, hosts, now.AddSeconds(4)));
            Assert.Equal(hosts[0], health.Select(1, hosts, now.AddMinutes(3)));
        }
    }
}
