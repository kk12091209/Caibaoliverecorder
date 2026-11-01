using System;
using System.IO;
using System.IO.Pipelines;
using System.Threading;
using System.Threading.Tasks;
using BililiveRecorder.Flv;
using BililiveRecorder.Flv.Parser;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Recording
{
    public class RecordingPipeTests
    {
        private sealed class MemoryProvider : IMemoryStreamProvider
        {
            public MemoryStream CreateMemoryStream(string tag) => new MemoryStream();
        }

        private static byte[] AudioTag(int size)
        {
            var bytes = new byte[size + 15];
            bytes[4] = 8;
            bytes[5] = (byte)(size >> 16);
            bytes[6] = (byte)(size >> 8);
            bytes[7] = (byte)size;
            bytes[15] = 0x2f;
            return bytes;
        }

        [Theory]
        [InlineData(131072, 4096)]
        [InlineData(0xffffff, 65536)]
        public async Task CompleteLargeTagAndFollowingSmallTagWithoutDeadlockAsync(int size, int chunkSize)
        {
            // Match StandardRecordTask's production pipe and actual FLV reader.
            var pipe = new Pipe(new PipeOptions(useSynchronizationContext: false));
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
            using var reader = new FlvTagPipeReader(pipe.Reader, new MemoryProvider(), false, false);
            async Task ProduceAsync()
            {
                try
                {
                    await pipe.Writer.WriteAsync(new byte[] { 70, 76, 86, 1, 4, 0, 0, 0, 9 }, timeout.Token);
                    foreach (var data in new[] { AudioTag(size), AudioTag(32) })
                        for (int offset = 0; offset < data.Length; offset += chunkSize)
                        {
                            await pipe.Writer.WriteAsync(data.AsMemory(offset, Math.Min(chunkSize, data.Length - offset)), timeout.Token);
                            await Task.Yield();
                        }
                }
                finally { await pipe.Writer.CompleteAsync(); }
            }
            var producing = ProduceAsync();
            try
            {
                var first = await reader.ReadTagAsync(timeout.Token);
                Assert.NotNull(first);
                Assert.Equal((uint)size, first!.Size);
                Assert.Equal(size, first.BinaryData!.Length);
                first.BinaryData.Dispose();
                var second = await reader.ReadTagAsync(timeout.Token);
                Assert.NotNull(second);
                Assert.Equal(32u, second!.Size);
                second.BinaryData!.Dispose();
                Assert.Null(await reader.ReadTagAsync(timeout.Token));
                await producing;
            }
            finally
            {
                timeout.Cancel();
                try { await producing; } catch (OperationCanceledException) { }
            }
        }

        [Fact]
        public async Task PartialTagReadCanBeCancelledAsync()
        {
            var pipe = new Pipe(new PipeOptions(useSynchronizationContext: false));
            using var reader = new FlvTagPipeReader(pipe.Reader, new MemoryProvider(), false, false);
            await pipe.Writer.WriteAsync(new byte[] { 70, 76, 86, 1, 4, 0, 0, 0, 9 });
            await pipe.Writer.WriteAsync(AudioTag(131072).AsMemory(0, 1024));
            using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await reader.ReadTagAsync(cancellation.Token));
            await pipe.Writer.CompleteAsync();
        }
    }
}
