[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Source,
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$Icon
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Updating PE icon resources requires Windows.' }
$Source = (Resolve-Path -LiteralPath $Source).Path
$Icon = (Resolve-Path -LiteralPath $Icon).Path
$Destination = [IO.Path]::GetFullPath($Destination)
if ($Source.Equals($Destination, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source and destination must differ.' }
if (Test-Path -LiteralPath $Destination) { throw 'The temporary SFX destination must not already exist.' }

if (-not ('RecorderPackaging.IconResourceUpdater' -as [type])) {
$code = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace RecorderPackaging {
    public static class IconResourceUpdater {
        private const int RT_ICON = 3, RT_GROUP_ICON = 14;
        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate bool EnumNames(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate bool EnumLanguages(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool FreeLibrary(IntPtr module);
        [DllImport("kernel32.dll", EntryPoint="EnumResourceNamesW", SetLastError=true)]
        private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNames callback, IntPtr parameter);
        [DllImport("kernel32.dll", EntryPoint="EnumResourceLanguagesW", SetLastError=true)]
        private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLanguages callback, IntPtr parameter);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern IntPtr BeginUpdateResource(string file, bool deleteExistingResources);
        [DllImport("kernel32.dll", EntryPoint="UpdateResourceW", SetLastError=true)]
        private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint bytes);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool EndUpdateResource(IntPtr update, bool discard);
        [DllImport("kernel32.dll", EntryPoint="FindResourceExW", SetLastError=true)]
        private static extern IntPtr FindResourceEx(IntPtr module, IntPtr type, IntPtr name, ushort language);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern uint SizeofResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LockResource(IntPtr resource);

        private sealed class Group {
            public ushort Id, Language;
            public string Name;
            public bool IsNumber;
            public IntPtr Pointer() { return IsNumber ? new IntPtr(Id) : Marshal.StringToHGlobalUni(Name); }
            public void Release(IntPtr pointer) { if (!IsNumber) Marshal.FreeHGlobal(pointer); }
        }
        private sealed class IconImage { public byte[] Header, Data; public ushort Id; }
        public sealed class Result { public int Images, Groups, Languages; }

        private static void Check(bool result, string operation) {
            if (!result) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
        private static bool IsNumber(IntPtr value) {
            return unchecked((ulong)value.ToInt64()) <= 65535;
        }
        private static void CheckEnumeration(bool result, string operation) {
            if (result) return;
            int error = Marshal.GetLastWin32Error();
            if (error != 1812 && error != 1813 && error != 1814 && error != 1815)
                throw new Win32Exception(error, operation);
        }

        // Resource editing is only safe on the bare PE template, never an SFX
        // that already has a 7z archive appended beyond its PE sections.
        public static void ValidateTemplate(string file) {
            byte[] data = File.ReadAllBytes(file);
            if (data.Length < 64 || data[0] != 77 || data[1] != 90) throw new InvalidDataException("Not a PE template.");
            int pe = BitConverter.ToInt32(data, 60);
            if (pe < 64 || pe > data.Length - 24 || BitConverter.ToUInt32(data, pe) != 0x4550)
                throw new InvalidDataException("Invalid PE header.");
            int count = BitConverter.ToUInt16(data, pe + 6), optional = pe + 24;
            int optionalSize = BitConverter.ToUInt16(data, pe + 20);
            long sections = (long)optional + optionalSize;
            if (optionalSize < 64 || sections + count * 40L > data.Length) throw new InvalidDataException("Invalid PE sections.");
            long end = BitConverter.ToUInt32(data, optional + 60);
            for (int i = 0; i < count; i++) {
                int section = checked((int)(sections + i * 40L));
                long size = BitConverter.ToUInt32(data, section + 16), offset = BitConverter.ToUInt32(data, section + 20);
                if (offset + size > data.Length) throw new InvalidDataException("PE section exceeds file.");
                end = Math.Max(end, offset + size);
            }
            if (end > data.Length) throw new InvalidDataException("Invalid PE extent.");
            for (long i = end; i < data.Length; i++)
                if (data[i] != 0) throw new InvalidDataException("Appended data detected. Only an unbundled SFX template may be updated.");
        }
        private static List<IconImage> ReadIcon(string file) {
            byte[] data = File.ReadAllBytes(file);
            if (data.Length < 6 || BitConverter.ToUInt16(data, 0) != 0 || BitConverter.ToUInt16(data, 2) != 1)
                throw new InvalidDataException("Invalid ICO header.");
            int count = BitConverter.ToUInt16(data, 4);
            if (count < 1 || 6L + count * 16L > data.Length) throw new InvalidDataException("Invalid ICO directory.");
            var images = new List<IconImage>();
            for (int i = 0; i < count; i++) {
                int entry = 6 + i * 16;
                uint length = BitConverter.ToUInt32(data, entry + 8), offset = BitConverter.ToUInt32(data, entry + 12);
                if (length == 0 || offset < 6L + count * 16L || (long)offset + length > data.Length)
                    throw new InvalidDataException("ICO image exceeds file.");
                var image = new IconImage { Header = new byte[8], Data = new byte[checked((int)length)] };
                Buffer.BlockCopy(data, entry, image.Header, 0, 8);
                Buffer.BlockCopy(data, checked((int)offset), image.Data, 0, image.Data.Length);
                images.Add(image);
            }
            return images;
        }
        private static byte[] GroupData(List<IconImage> images) {
            using (var stream = new MemoryStream())
            using (var writer = new BinaryWriter(stream)) {
                writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)images.Count);
                foreach (IconImage image in images) {
                    writer.Write(image.Header); writer.Write((uint)image.Data.Length); writer.Write(image.Id);
                }
                return stream.ToArray();
            }
        }
        private static byte[] ReadResource(IntPtr module, int type, IntPtr name, ushort language) {
            IntPtr resource = FindResourceEx(module, new IntPtr(type), name, language);
            Check(resource != IntPtr.Zero, "FindResourceEx");
            uint length = SizeofResource(module, resource);
            IntPtr loaded = LoadResource(module, resource), pointer = LockResource(loaded);
            Check(loaded != IntPtr.Zero && pointer != IntPtr.Zero, "LoadResource");
            byte[] data = new byte[checked((int)length)]; Marshal.Copy(pointer, data, 0, data.Length); return data;
        }
        private static bool Equal(byte[] first, byte[] second) {
            if (first.Length != second.Length) return false;
            for (int i = 0; i < first.Length; i++) if (first[i] != second[i]) return false;
            return true;
        }
        public static Result Update(string template, string icon) {
            ValidateTemplate(template);
            List<IconImage> images = ReadIcon(icon);
            var groups = new List<Group>(); var used = new HashSet<ushort>();
            IntPtr module = LoadLibraryEx(template, IntPtr.Zero, 0x22);
            Check(module != IntPtr.Zero, "LoadLibraryEx");
            try {
                EnumNames iconNames = delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p) {
                    if (IsNumber(n)) used.Add((ushort)n.ToInt64()); return true;
                };
                CheckEnumeration(EnumResourceNames(module, new IntPtr(RT_ICON), iconNames, IntPtr.Zero), "Enumerate icons");
                Exception callbackError = null;
                EnumNames groupNames = delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p) {
                    bool number = IsNumber(n); ushort id = number ? (ushort)n.ToInt64() : (ushort)0;
                    string name = number ? null : Marshal.PtrToStringUni(n);
                    EnumLanguages languages = delegate(IntPtr lm, IntPtr lt, IntPtr ln, ushort language, IntPtr lp) {
                        groups.Add(new Group { Id=id, Name=name, IsNumber=number, Language=language }); return true;
                    };
                    if (!EnumResourceLanguages(m, t, n, languages, IntPtr.Zero)) {
                        callbackError = new Win32Exception(Marshal.GetLastWin32Error(), "Enumerate icon languages"); return false;
                    }
                    GC.KeepAlive(languages); return true;
                };
                bool enumerated = EnumResourceNames(module, new IntPtr(RT_GROUP_ICON), groupNames, IntPtr.Zero);
                if (callbackError != null) throw callbackError;
                CheckEnumeration(enumerated, "Enumerate icon groups");
                GC.KeepAlive(iconNames); GC.KeepAlive(groupNames);
            } finally { FreeLibrary(module); }
            if (groups.Count == 0) groups.Add(new Group { IsNumber=true, Id=1, Language=0 });
            int candidate = 1;
            foreach (IconImage image in images) {
                while (candidate <= 65535 && used.Contains((ushort)candidate)) candidate++;
                if (candidate > 65535) throw new InvalidDataException("No free icon resource IDs.");
                image.Id = (ushort)candidate; used.Add(image.Id); candidate++;
            }
            var languagesToWrite = new HashSet<ushort>();
            foreach (Group group in groups) languagesToWrite.Add(group.Language);
            byte[] groupData = GroupData(images);
            IntPtr update = BeginUpdateResource(template, false);
            Check(update != IntPtr.Zero, "BeginUpdateResource");
            try {
                foreach (ushort language in languagesToWrite)
                    foreach (IconImage image in images)
                        Check(UpdateResource(update, new IntPtr(RT_ICON), new IntPtr(image.Id), language, image.Data, (uint)image.Data.Length), "Write icon image");
                foreach (Group group in groups) {
                    IntPtr name = group.Pointer();
                    try { Check(UpdateResource(update, new IntPtr(RT_GROUP_ICON), name, group.Language, groupData, (uint)groupData.Length), "Write icon group"); }
                    finally { group.Release(name); }
                }
                bool committed = EndUpdateResource(update, false); update = IntPtr.Zero;
                Check(committed, "Commit icon resources");
            } finally { if (update != IntPtr.Zero) EndUpdateResource(update, true); }
            // Verify every group/language and image after Windows commits the PE.
            module = LoadLibraryEx(template, IntPtr.Zero, 0x22);
            Check(module != IntPtr.Zero, "Reload updated template");
            try {
                foreach (Group group in groups) {
                    IntPtr name = group.Pointer();
                    try { if (!Equal(ReadResource(module, RT_GROUP_ICON, name, group.Language), groupData)) throw new InvalidDataException("Icon group verification failed."); }
                    finally { group.Release(name); }
                }
                foreach (ushort language in languagesToWrite)
                    foreach (IconImage image in images)
                        if (!Equal(ReadResource(module, RT_ICON, new IntPtr(image.Id), language), image.Data)) throw new InvalidDataException("Icon image verification failed.");
            } finally { FreeLibrary(module); }
            return new Result { Images=images.Count, Groups=groups.Count, Languages=languagesToWrite.Count };
        }
    }
}
'@
    Add-Type -TypeDefinition $code -Language CSharp
}
[RecorderPackaging.IconResourceUpdater]::ValidateTemplate($Source)
$created = $false
try {
    # No overwrite: failure may remove only the new temporary copy owned here.
    $targetStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $created = $true
    try {
        $sourceStream = [IO.File]::OpenRead($Source)
        try { $sourceStream.CopyTo($targetStream) } finally { $sourceStream.Dispose() }
    } finally { $targetStream.Dispose() }
    $result = [RecorderPackaging.IconResourceUpdater]::Update($Destination, $Icon)
    [pscustomobject]@{
        Source = $Source
        Destination = $Destination
        Images = $result.Images
        Groups = $result.Groups
        Languages = $result.Languages
        Bytes = (Get-Item -LiteralPath $Destination).Length
    }
} catch {
    if ($created -and (Test-Path -LiteralPath $Destination -PathType Leaf)) { Remove-Item -LiteralPath $Destination -Force }
    throw
}
