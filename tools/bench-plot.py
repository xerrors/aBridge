"""Optional static report renderer. Requires matplotlib==3.11.2 and a CJK font.
The benchmark and default CI do not require Python; CI verifies the SVG input digest.
"""
import json, statistics, hashlib
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties
from matplotlib.patches import FancyBboxPatch

root=Path(__file__).resolve().parents[1]
base=json.loads((root/'docs/benchmarks/miniwob-agent-results.json').read_text())
fixed=json.loads((root/'docs/benchmarks/miniwob-tools-results.json').read_text())
holdout_path=root/'docs/benchmarks/miniwob-tools-holdout.json'
holdout=json.loads(holdout_path.read_text()) if holdout_path.exists() else None
fonts=[Path('/System/Library/Fonts/STHeiti Medium.ttc'),Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')]
font_path=next((p for p in fonts if p.exists()),None)
if not font_path:
    raise SystemExit('A CJK font is required: install Noto Sans CJK or use macOS STHeiti.')
font=FontProperties(fname=str(font_path))
plt.rcParams.update({'font.family':font.get_name(),'axes.unicode_minus':False,'svg.fonttype':'path','svg.hashsalt':'abridge-benchmark-v1'})
plt.rcParams['font.sans-serif']=[font.get_name()]
from matplotlib import font_manager
font_manager.fontManager.addfont(str(font_path))
navy='#162b43';teal='#087e77';muted='#617084';red='#bb5b52';gray='#dce3eb';light='#f1f5f7'
fig=plt.figure(figsize=(15,10.5),facecolor='white')
def text(x,y,s,size=12,color=navy,weight='normal',**kw):
    fig.text(x,y,s,fontsize=size,color=color,fontproperties=font,weight=weight,**kw)
def summary(d):
    es=d['episodes'];known=[e['usage'] for e in es if e['usage']]
    return dict(n=len(es),s=sum(e['success'] for e in es),tool=sum(e['toolCalls'] for e in es),
      p50=statistics.median(e['elapsedMs']/1000 for e in es if e['elapsedMs'] is not None),
      input=sum(u['inputTokens'] for u in known),cache=sum(u['cachedInputTokens'] for u in known),
      output=sum(u['outputTokens'] for u in known),coverage=len(known),cleanup=sum(e['cleanup'] for e in es))
a=summary(base);b=summary(fixed)
text(.055,.947,'aBridge · 浏览器 Agent 工具优化验证',25,weight='bold')
text(.055,.91,'固定 gpt-6.1-sol / medium · 原任务 prompt 不变 · 公开 MiniWoB++ 适配子集',12,muted)
for x,title,value,sub,color in [(.055,'原始基线',f"{a['s']}/{a['n']}",f"成功率 {a['s']/a['n']:.1%}",muted),(.355,'仅优化工具',f"{b['s']}/{b['n']}",f"成功率 {b['s']/b['n']:.1%}",teal),(.655,'额外种子验证',f"{summary(holdout)['s']}/{summary(holdout)['n']}" if holdout else '待测','seed = 2，单独统计',navy)]:
    fig.add_artist(FancyBboxPatch((x,.754),.282,.12,boxstyle='round,pad=0.008,rounding_size=0.012',transform=fig.transFigure,facecolor=light,edgecolor='none'))
    text(x+.015,.843,title,12,muted);text(x+.015,.788,value,29,color,weight='bold');text(x+.122,.792,sub,11,color)
text(.055,.705,'同一批任务的成功数',16,weight='bold')
ax=fig.add_axes([.23,.365,.36,.285]); tasks=base['protocol']['tasks']; y=list(range(len(tasks)))
bs=[sum(e['success'] for e in base['episodes'] if e['task']==t) for t in tasks]
fs=[sum(e['success'] for e in fixed['episodes'] if e['task']==t) for t in tasks]
ax.barh([i-.16 for i in y],bs,height=.28,color=gray,label='基线')
ax.barh([i+.16 for i in y],fs,height=.28,color=teal,label='工具优化')
ax.set_yticks(y,tasks,fontproperties=font,fontsize=10);ax.invert_yaxis();ax.set_xlim(0,2.6);ax.set_xticks([0,1,2],['0','1','2']);ax.tick_params(axis='both',length=0,labelcolor=muted)
for i,(v,w) in enumerate(zip(bs,fs)):
    ax.text(v+.05,i-.16,f'{v}/2',va='center',fontsize=10,color=muted)
    ax.text(w+.05,i+.16,f'{w}/2',va='center',fontsize=10,color=teal)
for sp in ax.spines.values():sp.set_visible(False)
ax.legend(loc='upper left',bbox_to_anchor=(-.35,1.1),frameon=False,ncol=2,prop=font)
text(.65,.705,'端到端失败分类',16,weight='bold')
names={'task_tab_lost':'动作后任务页丢失','goal_not_finished':'目标未完成','time_budget':'超出时间预算','goal_incorrect':'目标错误','agent_error':'Agent 运行错误','setup_or_grading_error':'判分 / 环境错误','tool_budget':'超出工具预算'}
def failures(d):
    r={}
    for e in d['episodes']:
        if e['failure']:r[e['failure']]=r.get(e['failure'],0)+1
    return r
fa,fb=failures(base),failures(fixed); keys=list(dict.fromkeys(list(fa)+list(fb)))
for i,k in enumerate(keys):
    yy=.645-i*.055;text(.65,yy,names.get(k,k),11,muted);text(.88,yy,f"{fa.get(k,0)} → {fb.get(k,0)}",14,teal,weight='bold')
text(.65,.405,f"会话清理：{b['cleanup']}/{b['n']}\n用量覆盖：{b['coverage']}/{b['n']}\n工具越权：{sum(e['toolViolations']>0 for e in fixed['episodes'])}",11,muted,linespacing=1.8)
fig.add_artist(plt.Line2D([.055,.945],[.318,.318],transform=fig.transFigure,color=gray,linewidth=1))
text(.055,.279,'主对照资源消耗（已知合计）',15,weight='bold')
cols=[(.055,'Agent 耗时 P50',f"{a['p50']:.1f}s → {b['p50']:.1f}s"),(.35,'工具调用',f"{a['tool']} → {b['tool']}"),(.65,'输出 tokens',f"{a['output']:,} → {b['output']:,}")]
for x,t,v in cols:text(x,.235,t,11,muted);text(x,.199,v,18,navy,weight='bold')
text(.055,.153,f"输入 tokens（含缓存）：{a['input']:,} → {b['input']:,}；缓存：{a['cache']:,} → {b['cache']:,}；用量覆盖 {a['coverage']}/{a['n']} → {b['coverage']}/{b['n']}。",10,muted)
text(.055,.135,f"非缓存输入：{a['input']-a['cache']:,} → {b['input']-b['cache']:,}；实际成本不能仅由总 tokens 推断。",9,muted)
text(.055,.108,'每例 180 秒 / 40 次工具调用；并发 2；seed 0、1 配对，失败不剔除、不重试。耗时包含模型与 CLI 启动。',10,muted)
text(.055,.083,'小样本；CLI出现模型目录刷新超时，端到端存在额外等待。不是官方榜单或速度/成本优势证明。',10,muted)
text(.055,.056,f"数据来源：docs/benchmarks/miniwob-{{agent-results,tools-results,tools-holdout}}.json · v{fixed['productVersion']} / {fixed['productCommit'][:7]}",9,muted)
artifact=root/'.local/bench/artifacts/benchmark-comparison.png';artifact.parent.mkdir(parents=True,exist_ok=True)
fig.savefig(artifact,dpi=190,facecolor='white')
svg=root/'docs/benchmarks/miniwob-comparison.svg'
fig.savefig(svg,facecolor='white',metadata={'Date':None})
inputs=['miniwob-agent-results.json','miniwob-tools-results.json','miniwob-tools-holdout.json']
digest=hashlib.sha256(b''.join((root/'docs/benchmarks'/f).read_bytes() for f in inputs)).hexdigest()
with svg.open('a') as out: out.write('\n<!-- abridge-input-sha256:'+digest+' -->\n')
print(artifact)
