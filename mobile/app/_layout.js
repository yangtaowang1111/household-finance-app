import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../lib/theme';
import { loadConfig } from '../lib/api';

/* The root. Config is loaded before anything renders, so no screen has to cope
   with a half-initialised state — the setup sheet either appears or it does
   not. */
export default function RootLayout() {
  const scheme = useColorScheme();
  const c = colors(scheme);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadConfig().finally(() => setReady(true));
  }, []);

  if (!ready) return null;

  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerLargeTitle: true,
          headerTransparent: false,
          headerStyle: { backgroundColor: c.bg },
          headerTitleStyle: { color: c.text },
          headerLargeTitleStyle: { color: c.text },
          headerTintColor: c.accent,
          contentStyle: { backgroundColor: c.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="settings"
          options={{ presentation: 'modal', title: 'Connection' }}
        />
      </Stack>
    </>
  );
}
