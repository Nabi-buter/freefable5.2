#!/bin/bash
# usage: curve.sh tag  -> runs 4x30 games (all chars, ashwood/frostmere, meta 0/2), prints wins + loss times + hp in wins
S=${OUT:-/tmp/cinderwake-curve}; mkdir -p $S
cd "$(dirname "$0")/../.."
for cfg in "ashwood 0" "frostmere 0" "emberwaste 2" "gloommire 2"; do set -- $cfg; npx tsx tests/simbot.ts 30 0 all 0.7 $1 $2 > $S/cv_${TAG}_$1.txt 2>&1 & done; wait
cat $S/cv_${TAG}_*.txt | python3 -c "
import sys,re
wins=0;n=0;early=0;late=[];loss=[];minhp=[]
for l in sys.stdin:
  m=re.match(r'#\d+ \S+ (WIN |LOSS) t=([\d.]+)m .*minHp=(\d+)% lateHp=(\d+)%',l)
  if not m: continue
  n+=1
  if m.group(1)=='WIN ': wins+=1; minhp.append(int(m.group(3))); late.append(int(m.group(4)))
  else:
    t=float(m.group(2)); loss.append(t)
    if t<6: early+=1
print('runs',n,'wins',wins,'losses<6min',early,'loss times',sorted(loss),'median minHp in wins',sorted(minhp)[len(minhp)//2] if minhp else '-', 'median lateHp in wins', sorted(late)[len(late)//2] if late else '-')
"
