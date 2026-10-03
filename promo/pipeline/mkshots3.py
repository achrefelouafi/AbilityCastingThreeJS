import json, math, sys
# Caster at the origin, casting along U. Cameras are written in the cast's own frame:
# (along U from the target, along S to the side, up), so a shot reads the same whatever the heading.
ang = math.atan2(5.5, -5.5)               # heading the exploration pass used (lighting looked good)
U = (math.sin(ang), math.cos(ang)); S = (U[1], -U[0])
def P(T, a, s, up=0.0): return [round(T[0]+U[0]*a+S[0]*s, 3), round(up, 3), round(T[1]+U[1]*a+S[1]*s, 3)]
def at(R): return (U[0]*R, U[1]*R)
def flat(p): return (p[0], p[2])
def spec(T, cam, look, orbit=0.25, push=0.9, rise=0.0, start=0, frames=270, fov=55):
    c = P(T, *cam); L = P(T, *look)
    dx, dz = c[0]-L[0], c[2]-L[1+1]
    yaw = math.atan2(dx, dz); dist = math.hypot(dx, dz); h = c[1]-L[1]
    return dict(look=L, yaw0=yaw, yaw1=yaw+orbit, dist0=dist, dist1=dist*push, height0=h, height1=h+rise, fov=fov, start=start, frames=frames)
def bystanders(T): return [list(flat(P(T, 4.5, -3.2))), list(flat(P(T, 5.0, 3.5)))]
def ringd(T, r, n, a0=0.4): return [[round(T[0]+math.cos(a0+i*2*math.pi/n)*r,2), round(T[1]+math.sin(a0+i*2*math.pi/n)*r,2)] for i in range(n)]
WIN = 4.5   # seconds captured per shot; the compositor trims to 4.0
def shot(name, R, skip_s, cam, look, dummies=None, timeScale=None, **kw):
    T = at(R)
    skip = round(skip_s*60); frames = round(WIN*60)
    d = dummies(T) if dummies else [list(T)] + bystanders(T)
    s = dict(name=name, element=name, target=list(T), dummies=d, skip=skip, frames=frames, dir='finalx',
             camera=spec(T, cam, look, start=skip, frames=frames, **kw))
    if timeScale: s['setup'] = f'settings.global.timeScale = {timeScale};'
    return s
aoe = lambda T: [list(T)] + ringd(T, 2.7, 4)
shots = [
  shot('shark',     7.0, 0.05, cam=(-8.0, 12.5, 6.6),  look=(0, 1.6, 1.0),   orbit=0.18, push=0.92, timeScale=0.8, dummies=lambda T: [list(T), list(flat(P(T, 4.5, -2.0))), list(flat(P(T, 3.0, -6.5)))]),
  shot('chains',    7.0, 0.00, cam=(-3.5, 8.8, 4.0),  look=(0, 0, 2.3),   orbit=0.30, timeScale=0.85),
  shot('dragon',    9.0, 2.20, cam=(-13.0, 8.8, 13.5), look=(0, 0, 0.8),  orbit=0.22, push=0.9, dummies=aoe),
  shot('gyro',      9.0, 0.20, cam=(-7.0, 11.0, 5.5), look=(0, 0, 3.4),   orbit=0.25, push=0.9, dummies=aoe),
  shot('amethyst',  7.0, 0.30, cam=(-3.3, 10.8, 6.4),  look=(0, 0, 1.3),   orbit=0.30),
  shot('tome',      9.0, 2.20, cam=(-6.5, 10.5, 5.2), look=(0, 0, 2.9),   orbit=0.25, push=0.9, dummies=aoe),
  shot('reliquary', 7.0, 1.80, cam=(-3.5, 9.5, 4.0),  look=(0, 0, 2.6),   orbit=-0.30, push=0.9),
  shot('lance',     7.0, 0.00, cam=(-10.0, 5.0, 3.4), look=(-3.2, 0.6, 1.3),   orbit=0.15, push=0.93, timeScale=0.42),
  shot('wolf',      7.0, 0.15, cam=(-11.0, 14.5, 7.4), look=(0, 0.8, 1.3),   orbit=0.15, push=0.94, timeScale=0.75),
]
json.dump(shots, open(sys.argv[1], 'w'), indent=1)
for s in shots: print(s['name'], s['camera']['look'], round(s['camera']['dist0'],1), round(s['camera']['height0'],1))
