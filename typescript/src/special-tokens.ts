/**
 * What the well-known control tokens mean. Tokenizers return IDs and bytes only, and IDs differ between
 * models, so a token is recognised by its exact text. Only text that can be a single special token is listed.
 */
export interface SpecialToken { label: string; meaning: string; models: string }

const START = 'Starts a new message. The role name (system, user, assistant) follows it as ordinary text.';
const END = 'Ends a message. When the model produces this itself, the runtime stops generating, which is how the harness knows the reply is complete.';
const BEGIN = 'Marks the very start of the whole prompt. The tokenizer usually adds it automatically.';
const STOP = 'Marks the end of the text. When the model produces it, generation stops.';
const GENERIC = 'Written between <| and |>, this is a control token: the model family reserves it to mark structure instead of carrying words. This glossary does not list it; the model template (Explore → model template) shows where it is used.';

const entry = (label: string, meaning: string, models: string): SpecialToken => ({ label, meaning, models });
const TABLE: Record<string, SpecialToken> = {
  '<|im_start|>': entry('start of message', START, 'ChatML: Qwen and others'),
  '<|im_end|>': entry('end of message', END, 'ChatML: Qwen and others'),
  '<|im_sep|>': entry('role separator', 'Separates the role name from the message text.', 'Phi-4'),
  '<|endoftext|>': entry('end of text', STOP, 'Qwen, GPT-2 family, Phi'),
  '<think>': entry('start of thinking', 'The model writes its reasoning between <think> and </think> before the answer. The reasoning is generated, and costs time like any output, but the harness does not send it back with later requests.', 'Qwen3, DeepSeek-R1'),
  '</think>': entry('end of thinking', 'The reasoning is finished; the answer follows.', 'Qwen3, DeepSeek-R1'),
  '<tool_call>': entry('start of tool call', 'The model writes a tool call (its name and arguments as JSON) between <tool_call> and </tool_call>. The harness reads the call, applies its approval policy and only then runs the tool.', 'Qwen'),
  '</tool_call>': entry('end of tool call', 'The tool call is complete.', 'Qwen'),
  '<tool_response>': entry('start of tool result', 'The harness puts a tool result between <tool_response> and </tool_response> so the model can tell it from the user’s words.', 'Qwen'),
  '</tool_response>': entry('end of tool result', 'The tool result is complete.', 'Qwen'),
  '<|fim_prefix|>': entry('code before the gap', 'Fill-in-the-middle: the code before the place to fill in.', 'Qwen coder'),
  '<|fim_suffix|>': entry('code after the gap', 'Fill-in-the-middle: the code after the place to fill in.', 'Qwen coder'),
  '<|fim_middle|>': entry('gap to fill', 'Fill-in-the-middle: the model writes the missing code after this token.', 'Qwen coder'),
  '<|file_sep|>': entry('file separator', 'Separates files when several are given as one prompt.', 'Qwen coder'),
  '<|repo_name|>': entry('repository name', 'Introduces the name of the repository the files belong to.', 'Qwen coder'),
  '<|fim_pad|>': entry('padding in fill-in-the-middle', 'Padding used when preparing fill-in-the-middle examples. It carries no meaning.', 'Qwen coder'),
  '<|vision_start|>': entry('start of image or video', 'Opens the place in the prompt where an image or video goes; <|vision_end|> closes it. Only vision-language models use it.', 'Qwen vision-language'),
  '<|vision_end|>': entry('end of image or video', 'Closes the place in the prompt where an image or video goes.', 'Qwen vision-language'),
  '<|vision_pad|>': entry('vision padding', 'Placeholder used to pad vision input. It carries no meaning of its own.', 'Qwen vision-language'),
  '<|image_pad|>': entry('image placeholder', 'Stands in for the image: the runtime repeats it once for every chunk of image data and swaps in the image\'s encoded values before the model reads the prompt.', 'Qwen vision-language'),
  '<|video_pad|>': entry('video placeholder', 'Stands in for the video, in the same way as <|image_pad|> does for an image.', 'Qwen vision-language'),
  '<|object_ref_start|>': entry('start of object name', 'Opens the name of an object the model is asked to find or describe in an image; <|object_ref_end|> closes it.', 'Qwen vision-language'),
  '<|object_ref_end|>': entry('end of object name', 'Closes the name of an object in an image.', 'Qwen vision-language'),
  '<|box_start|>': entry('start of bounding box', 'Opens the coordinates of a rectangle around something in an image; <|box_end|> closes it.', 'Qwen vision-language'),
  '<|box_end|>': entry('end of bounding box', 'Closes the coordinates of a bounding box.', 'Qwen vision-language'),
  '<|quad_start|>': entry('start of quadrilateral', 'Opens the corner coordinates of a four-sided shape in an image, such as tilted text; <|quad_end|> closes it.', 'Qwen vision-language'),
  '<|quad_end|>': entry('end of quadrilateral', 'Closes the corner coordinates of a four-sided shape.', 'Qwen vision-language'),
  '<|begin_of_text|>': entry('start of prompt', BEGIN, 'Llama 3'),
  '<|start_header_id|>': entry('start of role name', 'Opens the role name of a message; <|end_header_id|> closes it.', 'Llama 3'),
  '<|end_header_id|>': entry('end of role name', 'Closes the role name; the message text follows.', 'Llama 3'),
  '<|eot_id|>': entry('end of turn', END, 'Llama 3'),
  '<|eom_id|>': entry('end of message', 'Ends a message that is not the end of the turn, for example when the model is waiting for a tool result.', 'Llama 3.1'),
  '<|python_tag|>': entry('start of tool call', 'The model writes a tool call or code after this token.', 'Llama 3.1'),
  '<bos>': entry('start of prompt', BEGIN, 'Gemma'),
  '<eos>': entry('end of text', STOP, 'Gemma'),
  '<pad>': entry('padding', 'Fills unused positions so inputs have equal length. It carries no meaning.', 'Gemma and others'),
  '<start_of_turn>': entry('start of turn', START, 'Gemma'),
  '<end_of_turn>': entry('end of turn', END, 'Gemma'),
  '<s>': entry('start of prompt', BEGIN, 'Llama 2, Mistral'),
  '</s>': entry('end of text', STOP, 'Llama 2, Mistral'),
  '[INST]': entry('start of user instruction', 'Opens the user’s message.', 'Llama 2, Mistral'),
  '[/INST]': entry('end of user instruction', 'Closes the user’s message; the model’s answer follows.', 'Llama 2, Mistral'),
  '<<SYS>>': entry('start of system prompt', 'Opens the system prompt; <</SYS>> closes it.', 'Llama 2'),
  '<</SYS>>': entry('end of system prompt', 'Closes the system prompt.', 'Llama 2'),
  '[AVAILABLE_TOOLS]': entry('start of tool list', 'Opens the list of tool definitions the model may call.', 'Mistral'),
  '[/AVAILABLE_TOOLS]': entry('end of tool list', 'Closes the list of tool definitions.', 'Mistral'),
  '[TOOL_CALLS]': entry('start of tool calls', 'The model writes its tool calls after this token.', 'Mistral'),
  '[TOOL_RESULTS]': entry('start of tool results', 'Opens the results of tool calls.', 'Mistral'),
  '[/TOOL_RESULTS]': entry('end of tool results', 'Closes the results of tool calls.', 'Mistral'),
  '<|system|>': entry('system message', 'Starts the system message: the instructions the harness gives the model before the conversation.', 'Phi'),
  '<|user|>': entry('user message', 'Starts a message from the user.', 'Phi'),
  '<|assistant|>': entry('assistant message', 'Starts a message from the model.', 'Phi'),
  '<|end|>': entry('end of message', END, 'Phi, gpt-oss'),
  '<|start|>': entry('start of message', START, 'gpt-oss'),
  '<|message|>': entry('start of message text', 'Separates a message’s header (role and channel) from its text.', 'gpt-oss'),
  '<|channel|>': entry('channel', 'Introduces the channel of a message, such as the model’s reasoning or its final answer.', 'gpt-oss'),
  '<|constrain|>': entry('format constraint', 'Introduces the data format a tool call must follow.', 'gpt-oss'),
  '<|call|>': entry('end of tool call', 'The model has finished a tool call; the runtime stops so the harness can run it.', 'gpt-oss'),
  '<|return|>': entry('end of reply', 'The model has finished its final reply.', 'gpt-oss'),
  '<｜begin▁of▁sentence｜>': entry('start of prompt', BEGIN, 'DeepSeek'),
  '<｜end▁of▁sentence｜>': entry('end of text', STOP, 'DeepSeek'),
  '<｜User｜>': entry('user message', 'Starts a message from the user.', 'DeepSeek'),
  '<｜Assistant｜>': entry('assistant message', 'Starts a message from the model.', 'DeepSeek'),
};

/** The explanation for a token's exact text, or a generic one for an unlisted <|…|> control token. */
export function describeSpecialToken(text: string): SpecialToken | undefined {
  return Object.hasOwn(TABLE, text) ? TABLE[text] : /^<[|｜][^|｜<>\s]+[|｜]>$/.test(text) ? entry('control token', GENERIC, 'model-specific') : undefined;
}
