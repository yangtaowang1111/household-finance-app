import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { DEFAULT_BASE_URL, loadConfig, saveConfig } from '../lib/api';
import { Section, useTheme } from '../lib/ui';
import { radius, space, type } from '../lib/theme';

/* Where the NAS is, and the key to it.
 *
 * Presented as a modal because it is the one thing that must work before
 * anything else does, and because it is what an unreachable server sends you
 * to. Both values live on the device: compiling the address in would mean
 * rebuilding the app to change it, and compiling the key in would put it in a
 * public repository. */
export default function Settings({ onDone }) {
  const c = useTheme();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState(null);

  useEffect(() => {
    loadConfig().then((cfg) => {
      setBaseUrl(cfg.baseUrl);
      setApiKey(cfg.apiKey || '');
    });
  }, []);

  const field = {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    color: c.text,
    ...type.body,
  };

  async function save() {
    setStatus('Checkingâ€¦');
    await saveConfig({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
    try {
      // Proves the whole path â€” tailnet, server, key â€” before letting the user
      // leave thinking it worked.
      const res = await fetch(`${baseUrl.trim()}/api/networth`, {
        headers: { 'x-api-key': apiKey.trim() },
      });
      if (res.status === 401 || res.status === 403) return setStatus('That key was rejected.');
      if (!res.ok) return setStatus(`Server answered ${res.status}.`);
      setStatus('Connected.');
      setTimeout(() => onDone(), 500);
    } catch {
      setStatus('Could not reach it. Check Tailscale is connected on this device.');
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, padding: space.lg }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space.lg }}>
        <Text style={{ ...type.largeTitle, color: c.text }}>Connection</Text>
        <Pressable onPress={onDone} hitSlop={12}>
          <Text style={{ ...type.subhead, color: c.accent }}>Done</Text>
        </Pressable>
      </View>

      <Section
        title="NAS address"
        footer="The Tailscale address of the NAS. Reachable only while this device is on the tailnet â€” there is no public port."
      >
        <View style={{ padding: space.md }}>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={field}
          />
        </View>
      </Section>

      <Section title="API key" footer="The API_KEY from the NAS .env. Stored on this device only.">
        <View style={{ padding: space.md }}>
          <TextInput
            value={apiKey}
            onChangeText={setApiKey}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="Paste the key"
            placeholderTextColor={c.muted}
            style={field}
          />
        </View>
      </Section>

      <Pressable
        onPress={save}
        style={({ pressed }) => ({
          backgroundColor: c.accent,
          borderRadius: radius.md,
          paddingVertical: space.md,
          alignItems: 'center',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ ...type.headline, color: c.surface }}>Save and test</Text>
      </Pressable>

      {status ? (
        <Text style={{ ...type.subhead, color: c.muted, textAlign: 'center', marginTop: space.lg }}>
          {status}
        </Text>
      ) : null}
    </View>
  );
}
