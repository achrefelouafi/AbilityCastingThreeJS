n=$1
ffmpeg -y -loglevel error -i ${D:-clips}/$n.mp4 -vf "select='not(mod(n\,20))',scale=360:-1,drawtext=fontfile='C\:/Windows/Fonts/consola.ttf':text='%{pts}':x=6:y=6:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=5x6" -frames:v 1 -fps_mode vfr ${O:-sheets}/$n.jpg
