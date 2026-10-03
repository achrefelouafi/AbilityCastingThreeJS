import json, math, sys
# 10-second single-ability showcases, 1920x964 viewport (under a 116px header).
ang = math.atan2(5.5, -5.5)
U = (math.sin(ang), math.cos(ang)); S = (U[1], -U[0])
def P(T, a, s, up=0.0): return [round(T[0]+U[0]*a+S[0]*s, 3), round(up, 3), round(T[1]+U[1]*a+S[1]*s, 3)]
def at(R): return (U[0]*R, U[1]*R)
def flat(p): return (p[0], p[2])
FR = 600
def spec(T, cam, look, orbit, push, fov=40):
    c = P(T, *cam); L = P(T, *look)
    dx, dz = c[0]-L[0], c[2]-L[2]
    return dict(look=L, yaw0=math.atan2(dx, dz), yaw1=math.atan2(dx, dz)+orbit, dist0=math.hypot(dx, dz), dist1=math.hypot(dx, dz)*push,
                height0=c[1]-L[1], height1=c[1]-L[1], fov=fov, start=0, frames=FR, linear=True)
def bystanders(T): return [list(flat(P(T, 4.5, -3.2))), list(flat(P(T, 5.0, 3.5)))]
def ringd(T, r, n, a0=0.4): return [[round(T[0]+math.cos(a0+i*2*math.pi/n)*r,2), round(T[1]+math.sin(a0+i*2*math.pi/n)*r,2)] for i in range(n)]
aoe = lambda T: [list(T)] + ringd(T, 2.7, 4)
def shot(name, R, skip_s, ts, pause_s, cam, look, ctl, hue, dummies=None, orbit=0.6, push=0.85):
    T = at(R)
    d = dummies(T) if dummies else [list(T)] + bystanders(T)
    camera = spec(T, cam, look, orbit, push)
    camera['start'] = round(skip_s*60)  # the harness counts frames from the cast
    return dict(name=name, element=name, target=list(T), dummies=d, skip=round(skip_s*60), frames=FR, dir='solo',
                timeScale=ts, pause=round(pause_s*60), pauseLen=200, controls=ctl, hue=hue, camera=camera)
shots = [
  shot('shark',     7.0, 0.0, 0.55, 2.0, (-9.8, 1.2, 5.2),  (0, 0, 1.7),  [['abyssGlow', 2.4], ['rune', 3.0]], 130,
       dummies=lambda T: [list(T), list(flat(P(T, 4.5, 2.0))), list(flat(P(T, 5.0, -2.5)))], orbit=0.45),
  shot('chains',    7.0, 0.0, 0.6,  2.7, (-2.5, 8.6, 4.6),  (0, 0, 2.0),  [['lineGlow', 7.5], ['halo', 3.0]], 160),
  shot('dragon',    9.0, 2.0, 1.0,  2.4, (-6.0, 13.0, 7.5), (0, 0, 1.2),  [['tempEdge', 3300], ['ringIntensity', 5.5]], 190, dummies=aoe, orbit=0.5),
  shot('gyro',      9.0, 0.2, 1.0,  3.2, (-5.0, 12.5, 6.8), (0, 0, 2.4),  [['coreIntensity', 6.0], ['sigilFill', 0.6]], 150, dummies=aoe),
  shot('amethyst',  7.0, 0.0, 0.6,  2.5, (-2.0, 8.5, 4.8),  (0, 0, 1.3),  [['stoneInner', 2.6], ['circleIntensity', 3.2]], 200),
  shot('tome',      9.0, 1.8, 1.0,  2.0, (-5.0, 12.0, 6.6), (0, 0, 2.4),  [['sigilIntensity', 3.5], ['rimStrength', 3.0]], 160, dummies=aoe),
  shot('reliquary', 7.0, 0.5, 0.85, 2.4, (-3.5, 12.0, 5.0), (0, 0, 2.8),  [['sigilIntensity', 3.4], ['barkRim', 3.0]], 150),
  shot('lance',     7.0, 1.0, 0.3,  2.0, (-3.8, 8.6, 4.0),  (-2.6, 0, 1.4), [['glowIntensity', 1.6], ['ribbonIntensity', 3.5]], 180, orbit=0.4),
  shot('wolf',      7.0, 0.0, 0.45, 2.4, (-10.5, 1.5, 5.4), (0, 0, 1.6),  [['warp', 2.6], ['echoOpacity', 0.9]], 120, orbit=0.35, push=0.9),
]
json.dump(shots, open(sys.argv[1], 'w'), indent=1)
print(len(shots))
