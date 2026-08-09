import { createCompletionProofValidator } from "./completion-proof-validator.js";
import { createEvidenceAuthenticityValidator } from "./evidence-authenticity-validator.js";
import { createLlmReviewValidator } from "./llm-review-validator.js";
import { createSecurityScanValidator } from "./security-scan-validator.js";





function createDefaultValidators() {
  return Object.freeze([
    createEvidenceAuthenticityValidator(),
    createSecurityScanValidator(),
    createLlmReviewValidator(),
    createCompletionProofValidator(),
  ]);
}

export {
  createCompletionProofValidator,
  createDefaultValidators,
  createEvidenceAuthenticityValidator,
  createLlmReviewValidator,
  createSecurityScanValidator,
};
