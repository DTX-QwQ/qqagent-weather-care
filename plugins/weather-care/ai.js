// Keep model calls on the host's LLM pipeline, with no tool-selection step.
export function createCompleter(request,purpose='weather-care') {
  return async function complete(messages,signal,chatKey,maxTokens=700) {
    const r=await request({messages,tools:null,toolChoice:'none',maxTokens,temperature:0.7,
      signal:AbortSignal.any([signal,AbortSignal.timeout(45000)]),
      skillContext:{purpose,chatKey,thinkingMode:'off'}},0);
    if(r.finishReason==='length')throw new Error('AI 关怀输出被截断');
    const content=r.message?.content;
    const text=(typeof content==='string'?content:Array.isArray(content)?content.filter(p=>p.type==='text'&&typeof p.text==='string').map(p=>p.text).join('\n'):'').trim();
    if(!text)throw new Error('AI 没有返回关怀正文');
    return text;
  };
}
