# python compose_solo.py <name> -> outsolo/<name>.mp4  (1920x1080: 116px header + 1920x964 viewport)
import subprocess, sys
n = sys.argv[1]
args = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x05070d:s=1920x1080:r=60:d=10',
        '-i', f'solo/{n}.mp4', '-framerate', '60', '-i', f'ovlsolo/{n}/o_%04d.png',
        '-filter_complex', '[1:v]setpts=PTS-STARTPTS,format=yuv444p[v];[0:v][v]overlay=0:116[b];[b][2:v]overlay=0:0:format=auto,format=yuv420p[out]',
        '-map', '[out]', '-t', '10', '-r', '60', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', f'outsolo/{n}.mp4']
subprocess.run(args, check=True)
print('wrote', n)
