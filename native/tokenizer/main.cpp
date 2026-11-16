// MyHarness tokenizer helper: one small program that shows how a local Ollama model splits text into
// tokens. It answers only the websites it was started for, reads a model's vocabulary and tokenizes.
// It reads no project files, runs no commands, holds no conversation and never generates text.
#include "llama.h"
#include "nlohmann/json.hpp"
#include "cpp-httplib/httplib.h"
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char ** environ;
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#endif

using json = nlohmann::json;
namespace fs = std::filesystem;
constexpr size_t max_input = 8 * 1024 * 1024;
constexpr size_t max_output = 64 * 1024 * 1024;
constexpr int default_port = 5002;
static const char * default_origin = "https://harnessarium.com";
static const char * service_name = "myharness-token-helper";
static const char * agent_name = "com.harnessarium.token-helper";
static const char * run_key = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
static const char * run_value = "MyHarnessTokenHelper";

// A message that is safe to show in the web page: it names no path and repeats no input.
struct Unavailable : std::runtime_error { using std::runtime_error::runtime_error; };
// A problem with how the program was started; shown in the terminal.
struct Usage : std::runtime_error { using std::runtime_error::runtime_error; };

struct Settings {
    std::vector<std::string> origins;
    int port = default_port;
    std::string ollama_url = "http://localhost:11434", ollama_host = "localhost", mount_root = "/mnt";
    int ollama_port = 11434;
    bool ollama_plain = true;
    std::map<std::string, std::string> models;
    std::string action = "serve", entry_platform;
};

#ifdef _WIN32
static const char * this_platform = "windows";
#elif defined(__APPLE__)
static const char * this_platform = "macos";
#else
static const char * this_platform = "linux";
#endif

static std::string setting(const char * name) { const char * value = std::getenv(name); return value ? value : ""; }

// ---- settings ---------------------------------------------------------------------------------

static void set_ollama(Settings & settings, const std::string & value) {
    static const std::regex pattern(R"(^(https?)://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?/?$)");
    std::smatch match;
    if (!std::regex_match(value, match, pattern)) throw Usage("OLLAMA_URL must be an address such as http://localhost:11434, without a path or credentials.");
    settings.ollama_plain = match[1] == "http";
    settings.ollama_host = match[2];
    settings.ollama_port = match[3].matched ? std::stoi(match[3]) : settings.ollama_plain ? 80 : 443;
    settings.ollama_url = value.back() == '/' ? value.substr(0, value.size() - 1) : value;
}

static Settings parse_settings(const std::vector<std::string> & args) {
    Settings settings;
    static const std::regex origin(R"(^https?://(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:[0-9]{1,5})?$)");
    for (size_t i = 0; i < args.size(); ++i) {
        const auto & arg = args[i];
        const bool more = i + 1 < args.size();
        if (arg == "--help") settings.action = "help";
        else if (arg == "--install" || arg == "--uninstall") {
            if (settings.action != "serve") throw Usage("Choose one of --install, --uninstall and --print-install.");
            settings.action = arg.substr(2);
        } else if (arg == "--print-install") {
            if (settings.action != "serve") throw Usage("Choose one of --install, --uninstall and --print-install.");
            settings.action = "print";
            settings.entry_platform = more && args[i + 1].rfind("--", 0) != 0 ? args[++i] : this_platform;
            if (settings.entry_platform != "linux" && settings.entry_platform != "macos" && settings.entry_platform != "windows") throw Usage("--print-install accepts linux, macos or windows.");
        } else if (arg == "--origin" && more) {
            if (!std::regex_match(args[++i], origin)) throw Usage("--origin must be an exact website address such as https://harnessarium.com (no path, no trailing slash).");
            settings.origins.push_back(args[i]);
        } else if (arg == "--port" && more) {
            const auto & text = args[++i];
            if (text.empty() || text.size() > 5 || text.find_first_not_of("0123456789") != std::string::npos || std::stoi(text) > 65535) throw Usage("--port must be a number from 0 to 65535.");
            settings.port = std::stoi(text);
        } else throw Usage("Unknown or incomplete option: " + arg + ". Try --help.");
    }
    if (settings.origins.empty()) settings.origins.push_back(default_origin);
    if (!setting("OLLAMA_URL").empty()) set_ollama(settings, setting("OLLAMA_URL"));
    if (!setting("MYHARNESS_WSL_MOUNT_ROOT").empty()) settings.mount_root = setting("MYHARNESS_WSL_MOUNT_ROOT");
    if (!setting("MYHARNESS_TOKENIZER_MODELS").empty()) {
        const auto data = json::parse(setting("MYHARNESS_TOKENIZER_MODELS"), nullptr, false);
        bool valid = data.is_object();
        if (valid) for (const auto & item : data.items()) valid = valid && item.value().is_string() && fs::path(item.value().get<std::string>()).is_absolute();
        if (!valid) throw Usage("MYHARNESS_TOKENIZER_MODELS must be a JSON object that maps exact Ollama model IDs to absolute GGUF file paths.");
        for (const auto & item : data.items()) settings.models[item.key()] = item.value().get<std::string>();
    }
    return settings;
}

// ---- finding the model file --------------------------------------------------------------------

// Windows Ollama reports drive paths. On Windows they are used as they are; under WSL the same files
// are reached through the drive mounts.
static std::string local_path(const std::string & file, const std::string & platform, const std::string & mount_root) {
    static const std::regex drive(R"(^([A-Za-z]):[\\/](.*)$)");
    std::smatch match;
    if (platform == "windows" || !std::regex_match(file, match, drive)) return file;
    std::string rest = match[2];
    for (auto & ch : rest) if (ch == '\\') ch = '/';
    return mount_root + "/" + std::string(1, char(std::tolower(static_cast<unsigned char>(match[1].str()[0])))) + "/" + rest;
}

// The helper asks its own Ollama which file a model uses. The page never supplies a path or an address.
static std::string reported_file(const Settings & settings, const std::string & model) {
    const bool local = settings.ollama_host == "localhost" || settings.ollama_host == "127.0.0.1" || settings.ollama_host == "[::1]";
    if (!local || !settings.ollama_plain) throw Unavailable("Ollama is not a plain local address for the tokenizer helper. Set MYHARNESS_TOKENIZER_MODELS where the helper runs to a matching local GGUF file.");
    httplib::Client client(settings.ollama_host == "[::1]" ? "::1" : settings.ollama_host, settings.ollama_port);
    client.set_connection_timeout(5); client.set_read_timeout(30);
    const auto response = client.Post("/api/show", json({{"model", model}}).dump(), "application/json");
    const auto data = response && response->status == 200 ? json::parse(response->body, nullptr, false) : json();
    if (!data.is_object()) throw Unavailable("The tokenizer helper could not ask Ollama about this model. Check that Ollama is running where the helper runs and that the model is installed.");
    const std::string modelfile = data.value("modelfile", json("")).is_string() ? data.value("modelfile", "") : "";
    static const std::regex from(R"((?:^|\n)[ \t]*FROM[ \t]+([^\r\n]+?)[ \t\r]*(?=\n|$))", std::regex::icase);
    static const std::regex adapter(R"((?:^|\n)[ \t]*ADAPTER[ \t])", std::regex::icase);
    std::smatch match;
    if (!std::regex_search(modelfile, match, from) || std::regex_search(modelfile, adapter)) throw Unavailable("Ollama did not report a usable model file. Set MYHARNESS_TOKENIZER_MODELS where the helper runs to a matching local GGUF file.");
    std::string file = match[1];
    if (file.size() > 1 && file.front() == '"' && file.back() == '"') file = file.substr(1, file.size() - 2);
    return local_path(file, this_platform, settings.mount_root);
}

struct ModelFile { std::string path, identity, key; };

static ModelFile find_model(const Settings & settings, const std::string & model) {
    static const std::regex id(R"(^[A-Za-z0-9][A-Za-z0-9._:/-]*$)");
    if (!std::regex_match(model, id)) throw Unavailable("Choose a valid exact Ollama model ID before inspecting its tokens.");
    ModelFile found;
    const auto configured = settings.models.find(model);
    if (configured != settings.models.end()) { found.path = configured->second; found.identity = "operator-configured GGUF for " + model; }
    else { found.path = reported_file(settings, model); found.identity = "Ollama-reported GGUF " + fs::path(found.path).filename().string(); }
    std::error_code error;
    const auto real = fs::canonical(fs::path(found.path), error);
    char magic[4] = {0, 0, 0, 0};
    if (!error && fs::is_regular_file(real, error) && !error) std::ifstream(real, std::ios::binary).read(magic, 4);
    if (std::string(magic, 4) != "GGUF") throw Unavailable("The model file is missing, unreadable or not a GGUF file on the computer running the tokenizer helper. For Docker, WSL or remote Ollama, set MYHARNESS_TOKENIZER_MODELS to an accessible matching file.");
    found.path = real.string();
    // A changed file is a different vocabulary: size and modification time are part of its identity.
    found.key = found.path + "|" + std::to_string(fs::file_size(real, error)) + "|" + std::to_string(fs::last_write_time(real, error).time_since_epoch().count());
    return found;
}

// ---- tokenizing --------------------------------------------------------------------------------

static json tokenize(const llama_vocab * vocab, const std::string & content) {
    const auto count = llama_tokenize(vocab, content.data(), int32_t(content.size()), nullptr, 0, false, true);
    if (count == std::numeric_limits<int32_t>::min()) throw std::runtime_error("token overflow");
    std::vector<llama_token> tokens(size_t(count < 0 ? -count : count));
    const auto actual = llama_tokenize(vocab, content.data(), int32_t(content.size()), tokens.data(), int32_t(tokens.size()), false, true);
    if (actual < 0 || size_t(actual) > tokens.size()) throw std::runtime_error("tokenization failed");
    json result = json::array();
    size_t size = 0;
    for (int32_t i = 0; i < actual; ++i) {
        std::vector<char> piece(64);
        auto length = llama_token_to_piece(vocab, tokens[i], piece.data(), int32_t(piece.size()), 0, true);
        if (length < 0) {
            if (length == std::numeric_limits<int32_t>::min() || size_t(-length) > max_output) throw std::runtime_error("piece limit");
            piece.resize(size_t(-length));
            length = llama_token_to_piece(vocab, tokens[i], piece.data(), int32_t(piece.size()), 0, true);
        }
        if (length < 0 || size_t(length) > piece.size()) throw std::runtime_error("piece conversion failed");
        // Raw bytes, not text: one token can hold only part of a UTF-8 character.
        size += size_t(length) * 4 + 32;
        if (size > max_output) throw std::runtime_error("output limit");
        result.push_back({{"id", tokens[i]}, {"bytes", std::vector<uint8_t>(piece.begin(), piece.begin() + length)}});
    }
    return result;
}

// One vocabulary stays loaded; another model or a changed file replaces it. Only vocabulary metadata is
// read: no weights, no inference context, no GPU.
class Vocabulary {
    std::mutex mutex;
    std::string key;
    llama_model * model = nullptr;
public:
    ~Vocabulary() { if (model) llama_model_free(model); }
    json tokens(const ModelFile & file, const std::string & content) {
        const std::lock_guard<std::mutex> lock(mutex);
        if (key != file.key) {
            if (model) llama_model_free(model);
            key.clear();
            auto params = llama_model_default_params();
            params.vocab_only = true;
            model = llama_model_load_from_file(file.path.c_str(), params);
            if (!model) throw Unavailable("The model file could not be read as a tokenizer vocabulary. Check that it is the GGUF file of this model.");
            key = file.key;
        }
        try { return tokenize(llama_model_get_vocab(model), content); }
        catch (const std::exception &) { throw Unavailable("Tokenization failed: the text or its token pieces exceed the tokenizer helper's limits."); }
    }
};

// ---- serving -----------------------------------------------------------------------------------

static void reply(httplib::Response & response, int status, const json & body) {
    response.status = status;
    response.set_content(body.dump(), "application/json");
}

static void serve(const Settings & settings) {
    httplib::Server server;
    Vocabulary vocabulary;
    static httplib::Server * running = nullptr;
    // One helper per port: a second start must fail instead of sharing the port with the first.
    server.set_socket_options([](socket_t handle) {
#ifdef _WIN32
        const BOOL exclusive = TRUE;
        setsockopt(handle, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char *>(&exclusive), sizeof(exclusive));
#else
        const int reuse = 1;
        setsockopt(handle, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
#endif
    });
    const int port = settings.port == 0 ? server.bind_to_any_port("127.0.0.1") : server.bind_to_port("127.0.0.1", settings.port) ? settings.port : -1;
    if (port < 0) throw Usage("Could not start the tokenizer helper: its port is already in use. It may already be running; otherwise choose another port with --port.");
    const std::string host = "127.0.0.1:" + std::to_string(port);
    server.set_payload_max_length(max_input + 64 * 1024);
    // Every request is checked here, before any route: the helper's own address and an allowed website.
    // This is enforced by the helper, not only advertised to the browser as CORS.
    server.set_pre_routing_handler([&](const httplib::Request & request, httplib::Response & response) {
        const auto origin = request.get_header_value("Origin");
        bool allowed = request.get_header_value("Host") == host;
        if (allowed) { allowed = false; for (const auto & item : settings.origins) allowed = allowed || item == origin; }
        if (!allowed) { reply(response, 403, {{"error", "This website is not allowed to use the tokenizer helper"}}); return httplib::Server::HandlerResponse::Handled; }
        response.set_header("Access-Control-Allow-Origin", origin); response.set_header("Vary", "Origin");
        response.set_header("Access-Control-Allow-Headers", "Content-Type"); response.set_header("Access-Control-Allow-Methods", "POST, OPTIONS");
        response.set_header("Access-Control-Allow-Private-Network", "true"); response.set_header("Cache-Control", "no-store");
        if (request.method == "OPTIONS") { response.status = 204; return httplib::Server::HandlerResponse::Handled; }
        return httplib::Server::HandlerResponse::Unhandled;
    });
    server.Post("/v1/info", [&](const httplib::Request &, httplib::Response & response) {
        json models = json::array();
        for (const auto & item : settings.models) models.push_back(item.first);
        reply(response, 200, {{"value", {{"protocol", 2}, {"ollamaUrl", settings.ollama_url}, {"models", models}, {"automatic", true}}}});
    });
    server.Post("/v1/tokenize", [&](const httplib::Request & request, httplib::Response & response) {
        const auto body = json::parse(request.body, nullptr, false);
        if (!body.is_object() || !body.contains("model") || !body["model"].is_string() || !body.contains("content") || !body["content"].is_string()) { reply(response, 400, {{"error", "Tokenizer helper request needs a model and a content text"}}); return; }
        try {
            const auto file = find_model(settings, body["model"].get<std::string>());
            reply(response, 200, {{"value", {{"identity", file.identity}, {"tokens", vocabulary.tokens(file, body["content"].get<std::string>())}}}});
        } catch (const Unavailable & problem) { reply(response, 422, {{"error", problem.what()}}); }
    });
    server.set_error_handler([](const httplib::Request &, httplib::Response & response) {
        if (response.body.empty()) response.set_content(json({{"error", response.status == 413 ? "Tokenizer helper request is too large" : "Tokenizer helper route not found"}}).dump(), "application/json");
    });
    std::cout << "Tokenizer helper on http://" << host << "\nAllowed websites:";
    for (size_t i = 0; i < settings.origins.size(); ++i) std::cout << (i ? ", " : " ") << settings.origins[i];
    std::cout << "\nIt only reads tokenizer vocabularies. Stop it with Ctrl+C." << std::endl;
    running = &server;
    const auto stop = [](int) { running->stop(); };
    std::signal(SIGINT, stop); std::signal(SIGTERM, stop);
    server.listen_after_bind();
}

// ---- start at login ----------------------------------------------------------------------------

// The settings a login entry carries: only these, nothing else from the environment.
static std::map<std::string, std::string> recorded_settings() {
    std::map<std::string, std::string> values;
    for (const char * name : {"OLLAMA_URL", "MYHARNESS_TOKENIZER_MODELS", "MYHARNESS_WSL_MOUNT_ROOT"}) if (!setting(name).empty()) values[name] = setting(name);
    return values;
}

static std::vector<std::string> login_command(const Settings & settings, const std::string & program) {
    std::vector<std::string> command{program};
    for (const auto & origin : settings.origins) if (settings.origins.size() > 1 || origin != default_origin) { command.push_back("--origin"); command.push_back(origin); }
    if (settings.port != default_port) { command.push_back("--port"); command.push_back(std::to_string(settings.port)); }
    return command;
}

static std::string replaced(std::string text, const std::string & from, const std::string & to) {
    for (size_t at = 0; (at = text.find(from, at)) != std::string::npos; at += to.size()) text.replace(at, from.size(), to);
    return text;
}
// systemd: backslash and quote are escaped inside quotes; % and $ are its own specifiers.
static std::string unit_word(const std::string & value) { return "\"" + replaced(replaced(replaced(replaced(value, "\\", "\\\\"), "\"", "\\\""), "%", "%%"), "$", "$$") + "\""; }
static std::string xml(const std::string & value) { return replaced(replaced(replaced(value, "&", "&amp;"), "<", "&lt;"), ">", "&gt;"); }

// The text of the per-user login entry for a system. No administrator rights are involved anywhere.
static std::string login_entry(const std::string & platform, const std::vector<std::string> & command, const std::map<std::string, std::string> & values) {
    for (const auto & word : command) if (word.find_first_of("\r\n") != std::string::npos) throw Usage("Start at login cannot store values that contain line breaks.");
    for (const auto & item : values) if (item.second.find_first_of("\r\n") != std::string::npos) throw Usage("Start at login cannot store values that contain line breaks.");
    std::string text;
    if (platform == "linux") {
        text = "[Unit]\nDescription=MyHarness tokenizer helper\n\n[Service]\nExecStart=";
        for (size_t i = 0; i < command.size(); ++i) text += (i ? " " : "") + unit_word(command[i]);
        for (const auto & item : values) text += "\nEnvironment=" + unit_word(item.first + "=" + item.second);
        return text + "\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n";
    }
    if (platform == "macos") {
        text = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n"
               "  <key>Label</key>\n  <string>" + std::string(agent_name) + "</string>\n  <key>ProgramArguments</key>\n  <array>\n";
        for (const auto & word : command) text += "    <string>" + xml(word) + "</string>\n";
        text += "  </array>\n";
        if (!values.empty()) {
            text += "  <key>EnvironmentVariables</key>\n  <dict>\n";
            for (const auto & item : values) text += "    <key>" + xml(item.first) + "</key>\n    <string>" + xml(item.second) + "</string>\n";
            text += "  </dict>\n";
        }
        return text + "  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n</dict>\n</plist>\n";
    }
    // Windows: one command line in the user's Run registry key. It cannot carry settings.
    if (!values.empty()) throw Usage("Start at login on Windows cannot carry environment settings. Set them for your user account in Windows, then install again without them.");
    for (size_t i = 0; i < command.size(); ++i) {
        if (command[i].find('"') != std::string::npos) throw Usage("Start at login cannot store values that contain double quotes.");
        text += (i ? " " : "") + (command[i].find_first_of(" \t") != std::string::npos ? "\"" + command[i] + "\"" : command[i]);
    }
    return text + "\n";
}

static std::string program_path() {
#ifdef _WIN32
    char buffer[MAX_PATH];
    const auto length = GetModuleFileNameA(nullptr, buffer, MAX_PATH);
    return std::string(buffer, length);
#elif defined(__APPLE__)
    char buffer[4096];
    uint32_t size = sizeof(buffer);
    _NSGetExecutablePath(buffer, &size);
    return fs::canonical(buffer).string();
#else
    return fs::canonical("/proc/self/exe").string();
#endif
}

#ifndef _WIN32
// Runs a system program directly, without a shell, and reports whether it succeeded.
static bool run(const std::vector<std::string> & words) {
    std::vector<char *> argv;
    for (const auto & word : words) argv.push_back(const_cast<char *>(word.c_str()));
    argv.push_back(nullptr);
    posix_spawn_file_actions_t quiet;
    posix_spawn_file_actions_init(&quiet);
    posix_spawn_file_actions_addopen(&quiet, 1, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addopen(&quiet, 2, "/dev/null", O_WRONLY, 0);
    pid_t child = 0;
    int status = 0;
    const bool started = posix_spawnp(&child, argv[0], &quiet, nullptr, argv.data(), environ) == 0;
    posix_spawn_file_actions_destroy(&quiet);
    return started && waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
#endif

static std::string login_location() {
#ifdef _WIN32
    return std::string("HKCU\\") + run_key + "\\" + run_value;
#elif defined(__APPLE__)
    return setting("HOME") + "/Library/LaunchAgents/" + agent_name + ".plist";
#else
    return setting("HOME") + "/.config/systemd/user/" + service_name + ".service";
#endif
}

static void install(const Settings & settings) {
    const auto entry = login_entry(this_platform, login_command(settings, program_path()), recorded_settings());
    const auto location = login_location();
    bool enabled = false, started = true;
#ifdef _WIN32
    const auto line = entry.substr(0, entry.size() - 1);
    enabled = RegSetKeyValueA(HKEY_CURRENT_USER, run_key, run_value, REG_SZ, line.c_str(), DWORD(line.size() + 1)) == ERROR_SUCCESS;
    started = false;
#else
    std::error_code error;
    fs::create_directories(fs::path(location).parent_path(), error);
    { std::ofstream file(location, std::ios::binary | std::ios::trunc); file << entry; enabled = bool(file.flush()); }
#ifdef __APPLE__
    // Replacing an entry: unload the old one first; that fails harmlessly when there is none.
    if (enabled) { run({"launchctl", "unload", location}); enabled = run({"launchctl", "load", "-w", location}); }
#else
    enabled = enabled && run({"systemctl", "--user", "daemon-reload"}) && run({"systemctl", "--user", "enable", "--now", std::string(service_name) + ".service"});
#endif
    // A login entry that could not be enabled is not left behind.
    if (!enabled) fs::remove(location, error);
#endif
    if (!enabled) throw Usage("Could not enable start at login on this system. Start the tokenizer helper yourself when you need it.");
    std::cout << "The tokenizer helper now starts at every login (" << location << ").\nIt serves:";
    for (size_t i = 0; i < settings.origins.size(); ++i) std::cout << (i ? ", " : " ") << settings.origins[i];
    std::cout << (started ? "\nIt is running now. Remove this with --uninstall." : "\nIt starts at your next login; run it once now to use it today. Remove this with --uninstall.") << std::endl;
}

static void uninstall() {
    const auto location = login_location();
#ifdef _WIN32
    RegDeleteKeyValueA(HKEY_CURRENT_USER, run_key, run_value);
#else
    std::error_code error;
#ifdef __APPLE__
    run({"launchctl", "unload", "-w", location});
#else
    run({"systemctl", "--user", "disable", "--now", std::string(service_name) + ".service"});
#endif
    fs::remove(location, error);
#endif
    std::cout << "The tokenizer helper no longer starts at login." << std::endl;
}

int main(int argc, char ** argv) {
    try {
        const auto settings = parse_settings(std::vector<std::string>(argv + 1, argv + argc));
        if (settings.action == "help") {
            std::cout << "token-helper [--origin " << default_origin << "]... [--port " << default_port << "] [--install | --uninstall | --print-install [linux|macos|windows]]\n"
                         "Shows token pieces for local Ollama models in the MyHarness token viewer. It tokenizes text and does nothing else.\n"
                         "--install starts the helper at every login with these settings; --uninstall removes that. Neither needs administrator rights.\n"
                         "--print-install shows the login entry without changing anything.\n"
                         "Optional environment: OLLAMA_URL, MYHARNESS_TOKENIZER_MODELS, MYHARNESS_WSL_MOUNT_ROOT. See TOKENIZATION.md." << std::endl;
        } else if (settings.action == "print") std::cout << login_entry(settings.entry_platform, login_command(settings, program_path()), recorded_settings());
        else if (settings.action == "install") install(settings);
        else if (settings.action == "uninstall") uninstall();
        else serve(settings);
        return 0;
    } catch (const Usage & problem) {
        std::cerr << problem.what() << std::endl;
        return 1;
    }
}
