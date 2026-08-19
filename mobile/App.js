import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StatusBar, Text, View, useColorScheme } from 'react-native';
import { colors, space, type } from './lib/theme';
import { loadConfig } from './lib/api';
import Overview from './screens/Overview';
import Transactions from './screens/Transactions';
import Budget from './screens/Budget';
import Settings from './screens/Settings';

/* Deliberately no navigation library.
 *
 * expo-router brought a config-plugin system that would not resolve under this
 * Node version, and for three screens with no deep linking and no history it was
 * buying nothing anyway — a state variable does the same job in ten lines. If
 * this app ever needs real navigation, that is the moment to add the dependency
 * back, not before. */

const TABS = [
  { key: 'overview', label: 'Overview', Screen: Overview },
  { key: 'transactions', label: 'Transactions', Screen: Transactions },
  { key: 'budget', label: 'Budget', Screen: Budget },
];

export default function App() {
  const scheme = useColorScheme();
  const c = colors(scheme);
  const [tab, setTab] = useState('overview');
  const [ready, setReady] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Config is loaded before anything renders, so no screen has to cope with a
  // half-initialised state.
  useEffect(() => {
    loadConfig()
      .then((cfg) => setShowSettings(!cfg.apiKey))
      .finally(() => setReady(true));
  }, []);

  if (!ready) return <View style={{ flex: 1, backgroundColor: c.bg }} />;

  if (showSettings) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
        <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />
        <Settings onDone={() => setShowSettings(false)} />
      </SafeAreaView>
    );
  }

  const Active = TABS.find((t) => t.key === tab).Screen;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />

      <View
        style={{
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
          paddingBottom: space.md,
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
        }}
      >
        <Text style={{ ...type.largeTitle, color: c.text }}>
          {TABS.find((t) => t.key === tab).label}
        </Text>
        <Pressable onPress={() => setShowSettings(true)} hitSlop={12}>
          <Text style={{ ...type.subhead, color: c.accent }}>Connection</Text>
        </Pressable>
      </View>

      <View style={{ flex: 1 }}>
        <Active onNeedsSetup={() => setShowSettings(true)} />
      </View>

      {/* A tab bar rather than a navigator. Text labels rather than SF Symbols,
          which were another native module to install and fail on. */}
      <View
        style={{
          flexDirection: 'row',
          borderTopWidth: 1,
          borderTopColor: c.line,
          backgroundColor: c.surface,
          paddingBottom: space.sm,
        }}
      >
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            style={{ flex: 1, alignItems: 'center', paddingVertical: space.md }}
          >
            <Text
              style={{
                ...type.footnote,
                fontWeight: tab === t.key ? '600' : '400',
                color: tab === t.key ? c.accent : c.muted,
              }}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}
