"""Collect runtime dependency notices without copying caches or user data."""
import json, shutil, sys, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path
out=Path(sys.argv[1]);root=Path(sys.argv[2]);downloads=root/'.tools/downloads'
files={
 'FFmpeg-COPYING.GPLv3':'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.GPLv3',
 'FFmpeg-LICENSE.md':'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/LICENSE.md',
 'ffmpeg-versions.txt':'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt'}
for name,url in files.items():
 file=downloads/name
 if not file.exists():
  with urllib.request.urlopen(url,timeout=60) as r:file.write_bytes(r.read())
 shutil.copy2(file,out/name)
nuget=root/'.tools/nuget';records=[];target=out/'nuget';target.mkdir()
deps=json.loads((root/'.tools/runtime/recorder/BililiveRecorder.Cli.deps.json').read_text())
for name,details in deps['libraries'].items():
 if details.get('type') not in ('package','runtimepack'):continue
 package,version=name.split('/',1);folder=nuget/package.lower()/version.lower()
 record={'package':package,'version':version,'source':f'https://www.nuget.org/packages/{package}/{version}'}
 if folder.exists():
  dest=target/package;dest.mkdir(exist_ok=True)
  for spec in folder.glob('*.nuspec'):
   shutil.copy2(spec,dest/spec.name)
   xml=ET.parse(spec).getroot()
   for elem in xml.iter():
    tag=elem.tag.split('}')[-1]
    if tag in ('license','licenseUrl','projectUrl','authors','copyright'):record[tag]=elem.text
    if tag=='license' and elem.get('type')=='file' and elem.text:
     file=(folder/elem.text).resolve()
     if file.is_relative_to(folder.resolve()) and file.is_file():shutil.copy2(file,dest/file.name)
  for file in folder.rglob('*'):
   if file.is_file() and any(word in file.name.lower() for word in ['license','thirdpartynotice','copying','copyright']) and file.suffix.lower() not in ['.dll','.xml']:
    shutil.copy2(file,dest/file.name)
 records.append(record)
(out/'nuget-dependencies.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
