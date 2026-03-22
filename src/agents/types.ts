/**
 * Agent backend interface — the only contract a backend needs to implement.
 */

export interface ImageAttachment {
  mimeType: string;
  data: Buffer;
}

export interface AgentBackend {
  /** Human-readable name for display. */
  name: string;
  /** Process a user message and return the response. */
  ask(userId: string, message: string): Promise<string>;
  /** Stream a response, calling onChunk with accumulated text on each delta. */
  askStream?(userId: string, message: string, onChunk: (text: string, done: boolean) => void): Promise<string>;
  /** Process a message with image attachments (vision). If not implemented, agent doesn't support images. */
  askWithImages?(userId: string, message: string, images: ImageAttachment[], onChunk?: (text: string, done: boolean) => void): Promise<string>;
  /** Clear conversation history for a user. */
  reset(userId: string): void;
}

export interface AgentConfig {
  agent: "claude-code" | "openai" | "anthropic" | "ollama" | "command" | "codex" | "gemini";
  model?: string;
  apiKey?: string;
  apiBase?: string;
  command?: string;
  systemPrompt?: string;
}

export async function createAgent(config: AgentConfig): Promise<AgentBackend> {
  switch (config.agent) {
    case "claude-code": {
      const { ClaudeCodeAgent } = await import("./claude-code.js");
      return new ClaudeCodeAgent();
    }
    case "codex": {
      const { CodexAgent } = await import("./codex.js");
      return new CodexAgent();
    }
    case "gemini": {
      const { GeminiAgent } = await import("./gemini.js");
      return new GeminiAgent();
    }
    case "openai": {
      const { OpenAIAgent } = await import("./openai.js");
      return new OpenAIAgent({
        apiKey: config.apiKey || process.env.OPENAI_API_KEY || "",
        model: config.model || "gpt-4o",
        apiBase: config.apiBase || process.env.OPENAI_API_BASE || "https://api.openai.com",
        systemPrompt: config.systemPrompt,
      });
    }
    case "anthropic": {
      const { AnthropicAgent } = await import("./anthropic.js");
      return new AnthropicAgent({
        apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || "",
        model: config.model || "claude-sonnet-4-6-20250514",
        apiBase: config.apiBase || process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com",
        systemPrompt: config.systemPrompt,
      });
    }
    case "ollama": {
      const { OllamaAgent } = await import("./ollama.js");
      return new OllamaAgent({
        model: config.model || "llama3",
        apiBase: config.apiBase || process.env.OLLAMA_HOST || "http://localhost:11434",
        systemPrompt: config.systemPrompt,
      });
    }
    case "command": {
      const { CommandAgent } = await import("./command.js");
      return new CommandAgent(config.command || "echo");
    }
    default:
      throw new Error(`未知的 agent 类型: ${config.agent}`);
  }
}
