// Shared reduction of hosted-model output to { response, tool_calls }. No repair: prose beside a call, several calls or no call
// stay visible so the strict decoders downstream can reject them.
// Workers AI returns either a top-level tool_calls list (Llama, Mistral, Qwen3-30B) or an OpenAI chat-completion envelope
// (Qwen3.8, GPT-OSS, Nemotron, GLM, Gemma, and every OpenAI-compatible provider).
export function normalizeWorkersAiOutput(result) {
    const message = result?.choices?.[0]?.message;
    const calls = Array.isArray(result?.tool_calls) && result.tool_calls.length ? result.tool_calls : Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const text = typeof result?.response === 'string' ? result.response : typeof message?.content === 'string' ? message.content : null;
    return { response: text, tool_calls: calls };
}
