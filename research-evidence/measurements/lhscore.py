import math
def erf(x):
    s=math.copysign(1,x); x=abs(x)
    a1,a2,a3,a4,a5,p=0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429,0.3275911
    t=1/(1+p*x); y=t*(a1+t*(a2+t*(a3+t*(a4+t*a5))))
    return s*(1-y*math.exp(-x*x))
def lognorm(p10,med,v):
    if v<=0: return 1
    sx=math.log(v/med)*0.9061938024368232/(-math.log(p10/med))
    c=(1-erf(sx))/2
    if v<=p10: c=max(0.9,min(1,c))
    return c
def score(p10,med,v):
    pc=lognorm(p10,med,v)
    if pc>0.9: pc+=0.05*(pc-0.9)
    return math.floor(pc*100)/100
M={'FCP':(1800,3000,10),'SI':(3387,5800,10),'LCP':(2500,4000,25),'TBT':(200,600,30),'CLS':(0.1,0.25,25)}
# thresholds where metric score drops below 1.00 and 0.99,0.98
for k,(p10,med,w) in M.items():
    out=[]
    for target in (1.0,0.99,0.98,0.95):
        lo,hi=1e-6,med
        for _ in range(100):
            mid=(lo+hi)/2
            if score(p10,med,mid)>=target: lo=mid
            else: hi=mid
        out.append((target,round(lo,3)))
    print(k,'weight',w,'max value for score>=',out)
# example combos
def total(vals):
    s=sum(score(M[k][0],M[k][1],v)*M[k][2] for k,v in vals.items())/100
    return round(s*100)
for ex in [dict(FCP=900,SI=1100,LCP=1200,TBT=0,CLS=0),dict(FCP=1000,SI=1300,LCP=1500,TBT=30,CLS=0.01),dict(FCP=1200,SI=1500,LCP=1800,TBT=50,CLS=0.02),dict(FCP=900,SI=1200,LCP=1300,TBT=60,CLS=0)]:
    print(ex,'->',total(ex), {k:score(M[k][0],M[k][1],v) for k,v in ex.items()})
