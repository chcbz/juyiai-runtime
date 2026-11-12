// Standalone semantic assertion fixture; no dependency on private Git revisions.
export const REOPEN = String.raw`def pptx_text_matches(text, instruction):
    # The original producer wraps at 40 columns into paragraphs. Reconstruct
    # layout whitespace only: ALL words and their order must match, not merely
    # a prefix/title. Do not treat create/validate alone as semantic reopen.
    return ' '.join(text.split()) == ' '.join(instruction.split())
`;
