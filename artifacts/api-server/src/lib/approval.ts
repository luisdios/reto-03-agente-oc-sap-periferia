/**
 * RC2: affirmative approval must start with "Aprobado", without questions,
 * negations or conditions. Ambiguous language fails closed.
 */
export function hasUnambiguousApproval(text: string): boolean {
  const normalized = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
  return /^aprobado\b/.test(normalized) &&
    !/[?¿]/.test(normalized) &&
    !/\b(no|nunca|sin|rechazado|denegado|cancelado|desaprobado|pendiente|si|cuando|hasta|sujeto|condicionado|condicion|quizas|tal vez|talvez|podria|probablemente|posiblemente|depende|tentativamente|provisionalmente|recepcion|recibido|revision|borrador)\b/.test(normalized);
}
