import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../services/assistant_bridge_service.dart';
import '../theme.dart';

/// The Assistant tab — drive the PC assistant from the phone.
///
/// The PC runs Myto's Assistant (desktop app → Settings → Assistant → policy →
/// Phone bridge ON). This screen holds the bridge URL + token (stored locally),
/// shows the live status, composes tone-matched drafts, and delivers an
/// approved draft into the PC's chat window.
class AssistantScreen extends StatefulWidget {
  const AssistantScreen({super.key});

  @override
  State<AssistantScreen> createState() => _AssistantScreenState();
}

class _AssistantScreenState extends State<AssistantScreen> {
  final _service = AssistantBridgeService();
  final _base = TextEditingController();
  final _token = TextEditingController();
  final _contact = TextEditingController();
  final _intent = TextEditingController();
  final _window = TextEditingController();

  bool _busy = false;
  String? _statusLine;
  String? _draft;

  static const _prefBase = 'assistant.bridge.url';
  static const _prefToken = 'assistant.bridge.token';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _base.text = prefs.getString(_prefBase) ?? '';
      _token.text = prefs.getString(_prefToken) ?? '';
    });
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefBase, _base.text.trim());
    await prefs.setString(_prefToken, _token.text.trim());
  }

  Future<void> _run(Future<void> Function() job) async {
    setState(() {
      _busy = true;
      _statusLine = null;
    });
    await _save();
    try {
      await job();
    } catch (e) {
      if (mounted) setState(() => _statusLine = 'failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _base.dispose();
    _token.dispose();
    _contact.dispose();
    _intent.dispose();
    _window.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Scaffold(
      backgroundColor: palette.bg,
      appBar: AppBar(title: const Text('Assistant')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            TextField(
              controller: _base,
              style: const TextStyle(fontSize: 13.5),
              decoration: const InputDecoration(
                labelText: 'PC bridge URL',
                hintText: 'e.g. http://192.168.0.104:48765',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _token,
              obscureText: true,
              style: const TextStyle(fontSize: 13.5),
              decoration: const InputDecoration(
                labelText: 'Bridge token',
                hintText: 'Myto → Settings → Assistant → Phone bridge',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                ElevatedButton(
                  onPressed: _busy
                      ? null
                      : () => _run(() async {
                            final s = await _service.status(_base.text, _token.text);
                            if (mounted) {
                              setState(() {
                                _statusLine = s['ok'] == true
                                    ? 'connected — assistant is ${s['hostReady'] == true ? 'ready' : 'warming up'}'
                                    : 'unexpected reply';
                              });
                            }
                          }),
                  child: Text(_busy ? '…' : 'Connect'),
                ),
              ],
            ),
            if (_statusLine != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _statusLine!,
                  style: TextStyle(color: palette.muted, fontSize: 12.5),
                ),
              ),
            const Divider(height: 32),
            Text('Compose a message in your tone', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            TextField(
              controller: _contact,
              style: const TextStyle(fontSize: 13.5),
              decoration: const InputDecoration(
                labelText: 'Who? e.g. Rafi Bhai',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _intent,
              maxLines: 2,
              style: const TextStyle(fontSize: 13.5),
              decoration: const InputDecoration(
                labelText: 'What should it say?',
                hintText: 'tell him I will be 30 minutes late',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            FilledButton(
              onPressed: _busy || _contact.text.trim().isEmpty || _intent.text.trim().isEmpty
                  ? null
                  : () => _run(() async {
                        final r = await _service.compose(
                          _base.text,
                          _token.text,
                          contact: _contact.text.trim(),
                          intent: _intent.text.trim(),
                        );
                        if (mounted) {
                          setState(() {
                            if (r['ok'] == true) {
                              _draft = r['draft'] as String?;
                              _statusLine = 'draft ready — nothing sent yet';
                            } else {
                              _statusLine = 'compose failed: ${r['detail']}';
                            }
                          });
                        }
                      }),
              child: Text(_busy ? 'working…' : 'Compose draft on PC'),
            ),
            if (_draft != null) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  border: Border.all(color: palette.accent.withValues(alpha: 0.4)),
                  borderRadius: BorderRadius.circular(12),
                  color: palette.surface,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'DRAFT — NOTHING SENT YET',
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.1,
                        color: palette.accent,
                      ),
                    ),
                    const SizedBox(height: 6),
                    SelectableText(_draft!, style: const TextStyle(fontSize: 14, height: 1.45)),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _window,
                      style: const TextStyle(fontSize: 13),
                      decoration: const InputDecoration(
                        isDense: true,
                        labelText: 'Window to paste into (optional) e.g. WhatsApp',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        FilledButton(
                          style: FilledButton.styleFrom(
                            backgroundColor: const Color(0xFF16A34A),
                            foregroundColor: Colors.white,
                          ),
                          onPressed: _busy
                              ? null
                              : () => _run(() async {
                                    final r = await _service.deliver(
                                      _base.text,
                                      _token.text,
                                      text: _draft!,
                                      windowTitle: _window.text.trim(),
                                      pressEnter: true,
                                    );
                                    if (mounted) {
                                      setState(() {
                                        _statusLine = r['ok'] == true
                                            ? 'delivered — check the chat on the PC'
                                            : 'delivery failed: ${r['detail']}';
                                        if (r['ok'] == true) _draft = null;
                                      });
                                    }
                                  }),
                          child: const Text('Approve & send'),
                        ),
                        const SizedBox(width: 8),
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => _run(() async {
                                    final r = await _service.deliver(
                                      _base.text,
                                      _token.text,
                                      text: _draft!,
                                      windowTitle: _window.text.trim(),
                                      pressEnter: false,
                                    );
                                    if (mounted) {
                                      setState(() {
                                        _statusLine = r['ok'] == true
                                            ? 'pasted on the PC — review and press Enter there'
                                            : 'paste failed: ${r['detail']}';
                                        if (r['ok'] == true) _draft = null;
                                      });
                                    }
                                  }),
                          child: const Text('Paste only'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 24),
            Text(
              'The bridge lives only on your Wi-Fi, guarded by the token. The PC shows its URLs '
              'and token in Myto → Settings → Assistant → Phone bridge.',
              style: TextStyle(fontSize: 11.5, color: palette.muted),
            ),
          ],
        ),
      ),
    );
  }
}
