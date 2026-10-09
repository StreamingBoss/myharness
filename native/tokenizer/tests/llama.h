#pragma once
// Fault-injection shim for our helper's own branches; never used by the real build.
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
struct llama_model {};
struct llama_vocab {};
using llama_token = int;
struct llama_model_params { bool vocab_only = false; };
inline llama_model_params llama_model_default_params() { return {}; }
inline llama_model * llama_model_load_from_file(const char * file, llama_model_params params) {
    if (!params.vocab_only) std::abort();
    return std::string(file) == "missing" ? nullptr : new llama_model;
}
inline void llama_model_free(llama_model * model) { delete model; }
inline const llama_vocab * llama_model_get_vocab(llama_model *) { static llama_vocab vocab; return &vocab; }
inline int llama_tokenize(const llama_vocab *, const char * input, int length, int * tokens, int capacity, bool add, bool parse) {
    if (add || !parse) std::abort();
    const std::string text(input, length);
    if (text == "overflow") return std::numeric_limits<int>::min();
    if (text.empty()) return 0;
    if (capacity == 0) return text == "positive" ? 1 : text == "output" ? -2000 : -2;
    if (text == "bad-count") return -3;
    if (text == "extra-count") return capacity + 1;
    const int token = text == "long" ? 2 : text == "piece-overflow" ? 3 : text == "piece-limit" ? 4 : text == "bad-piece" ? 5 : text == "extra-piece" ? 6 : text == "retry-piece" ? 7 : text == "output" ? 8 : 1;
    std::fill(tokens, tokens + capacity, token);
    return capacity;
}
inline int llama_token_to_piece(const llama_vocab *, int token, char * buffer, int capacity, int strip, bool special) {
    if (strip || !special) std::abort();
    if (token == 3) return std::numeric_limits<int>::min();
    if (token == 4) return -64 * 1024 * 1024 - 1;
    if (token == 5) return -1;
    if (token == 6) return capacity + 1;
    if (token == 7) return -100;
    const int length = token == 2 ? 100 : token == 8 ? 65536 : 3;
    if (capacity < length) return -length;
    std::memset(buffer, 255, length); buffer[0] = 0;
    return length;
}
