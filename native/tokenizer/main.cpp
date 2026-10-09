#include "llama.h"
#include "nlohmann/json.hpp"
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;
constexpr size_t max_input = 8 * 1024 * 1024;
constexpr size_t max_output = 64 * 1024 * 1024;

// A bounded reader: std::getline alone could allocate arbitrary amounts of memory.
static bool read_request(std::istream & input, std::string & line) {
    line.clear();
    char ch;
    while (input.get(ch)) {
        if (ch == '\n') return true;
        if (line.size() == max_input) throw std::runtime_error("input limit");
        line += ch;
    }
    if (!line.empty()) throw std::runtime_error("incomplete frame");
    return false;
}

static std::string tokenize(const llama_vocab * vocab, const std::string & line) {
    const auto request = json::parse(line);
    const auto content = request.at("content").get<std::string>();
    const auto count = llama_tokenize(vocab, content.data(), int32_t(content.size()), nullptr, 0, false, true);
    if (count == std::numeric_limits<int32_t>::min()) throw std::runtime_error("token overflow");
    std::vector<llama_token> tokens(size_t(count < 0 ? -count : count));
    const auto actual = llama_tokenize(vocab, content.data(), int32_t(content.size()), tokens.data(), int32_t(tokens.size()), false, true);
    if (actual < 0 || size_t(actual) > tokens.size()) throw std::runtime_error("tokenization failed");
    std::string result = "{\"tokens\":[";
    for (int32_t i = 0; i < actual; ++i) {
        std::vector<char> piece(64);
        auto length = llama_token_to_piece(vocab, tokens[i], piece.data(), int32_t(piece.size()), 0, true);
        if (length < 0) {
            if (length == std::numeric_limits<int32_t>::min() || size_t(-length) > max_output) throw std::runtime_error("piece limit");
            piece.resize(size_t(-length));
            length = llama_token_to_piece(vocab, tokens[i], piece.data(), int32_t(piece.size()), 0, true);
        }
        if (length < 0 || size_t(length) > piece.size()) throw std::runtime_error("piece conversion failed");
        std::vector<uint8_t> bytes(piece.begin(), piece.begin() + length);
        const auto encoded = json({{"id", tokens[i]}, {"bytes", bytes}}).dump();
        if (result.size() + encoded.size() + 4 > max_output) throw std::runtime_error("output limit");
        if (i) result += ',';
        result += encoded;
    }
    return result + "]}";
}

int main(int argc, char ** argv) {
    if (argc != 3 || std::string(argv[1]) != "-m") {
        std::cerr << "Usage: myharness-tokenizer -m matching-model.gguf\n";
        return 2;
    }
    auto params = llama_model_default_params();
    params.vocab_only = true;
    std::unique_ptr<llama_model, decltype(&llama_model_free)> model(llama_model_load_from_file(argv[2], params), llama_model_free);
    if (!model) { std::cerr << "Could not load tokenizer vocabulary.\n"; return 1; }
    const auto * vocab = llama_model_get_vocab(model.get());
    // No llama_context, llama_decode, tensor allocation or GPU backend initialization.
    std::cout << "{\"ready\":true,\"protocol\":1,\"vocab_only\":true}\n" << std::flush;
    try {
        std::string line;
        while (read_request(std::cin, line)) {
            try { std::cout << tokenize(vocab, line) << '\n' << std::flush; }
            catch (const std::exception &) {
                // Fixed error only: do not echo the request, filesystem paths or library errors.
                std::cout << "{\"error\":\"Tokenization failed: invalid request or tokenizer limit.\"}\n" << std::flush;
            }
        }
    } catch (const std::exception &) { std::cerr << "Invalid or oversized protocol frame.\n"; return 1; }
    return 0;
}
