# python compose_x.py <cmp.json> <overlay_dir> <out.mp4> : three 636x964 columns under a 116px header, 1920x1080
import json, subprocess, sys
v = json.load(open(sys.argv[1])); ov = sys.argv[2]; out = sys.argv[3]
D = v['duration']; HDR, CW, GAP = 116, 636, 6
args = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', f'color=c=0x05070d:s=1920x1080:r=60:d={D}']
for p in v['panels']:
    args += ['-ss', str(p['ss']), '-t', str(D), '-i', p['clip']]
args += ['-framerate', '60', '-i', f'{ov}/o_%04d.png']
fc = [f"[{i+1}:v]setpts=PTS-STARTPTS,format=yuv444p[p{i}]" for i in range(3)]
cur = '0:v'
for i in range(3):
    fc.append(f"[{cur}][p{i}]overlay={i*(CW+GAP)}:{HDR}[b{i}]"); cur = f'b{i}'
fc.append(f"[{cur}][4:v]overlay=0:0:format=auto,format=yuv420p[out]")
args += ['-filter_complex', ';'.join(fc), '-map', '[out]', '-t', str(D), '-r', '60',
         '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
         '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', out]
subprocess.run(args, check=True)
print('wrote', out)
