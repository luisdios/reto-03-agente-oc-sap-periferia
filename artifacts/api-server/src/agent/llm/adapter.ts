import type {
  Content,
  FunctionDeclaration,
  GenerateContentResponse,
} from "@google/genai";

export interface LlmAdapter {
  enviar(
    contents: Content[],
    systemInstruction: string,
    herramientas: FunctionDeclaration[],
  ): Promise<GenerateContentResponse>;
}
