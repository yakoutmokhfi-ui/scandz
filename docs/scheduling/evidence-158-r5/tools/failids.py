import re,sys
def ids(path):
    out=[];name=None
    lines=open(path,errors='replace').read().split('\n')
    for i,l in enumerate(lines):
        m=re.match(r'^(\s*)not ok \d+ - (.*)$',l)
        if m:
            name=m.group(2).strip(); loc=None
            for j in range(i+1,min(i+12,len(lines))):
                mm=re.search(r"location: '(.*?)'",lines[j])
                if mm: loc=mm.group(1);break
            if loc:
                loc=re.sub(r'^.*/tests/','tests/',loc); loc=re.sub(r':\d+:\d+$','',loc)
            out.append((loc,name))
    return out
if __name__=='__main__':
    for loc,n in sorted(set(ids(sys.argv[1])),key=lambda x:(str(x[0]),x[1])): print(f"{loc}\t{n[:140]}")
