import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import type { LlmAdapter } from "./adapter";

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const MAX_OUTPUT_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 30_000;

export class GeminiAdapter implements LlmAdapter {
  private client: GoogleGenAI | null = null;

  private getClient(): GoogleGenAI {
    if (this.client) return this.client;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Falta configurar GEMINI_API_KEY en los secretos del servidor.",
      );
    }

    this.client = new GoogleGenAI({ apiKey });
    return this.client;
  }

  async enviar(
    contents: Content[],
    systemInstruction: string,
    herramientas: FunctionDeclaration[],
  ) {
    const response = await this.getClient().models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: herramientas }],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.1,
        httpOptions: { timeout: REQUEST_TIMEOUT_MS },
      },
    });
    return response;
  }
}
