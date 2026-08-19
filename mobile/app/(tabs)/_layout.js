import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { colors } from '../../lib/theme';

/* A native tab bar with SF Symbols rather than a bundled icon set. Using the
   system's own icons is most of what makes an app feel like it belongs on the
   phone — they match the weight, the optical alignment and the platform's own
   idea of what a chart or a list looks like. */
function Icon({ name, color }) {
  return <SymbolView name={name} tintColor={color} size={26} type="hierarchical" />;
}

export default function TabsLayout() {
  const c = colors(useColorScheme());

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.muted,
        headerLargeTitle: true,
        headerStyle: { backgroundColor: c.bg },
        headerTitleStyle: { color: c.text },
        headerLargeTitleStyle: { color: c.text },
        headerTintColor: c.accent,
        sceneStyle: { backgroundColor: c.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Overview',
          tabBarIcon: ({ color }) => <Icon name="chart.pie" color={color} />,
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          title: 'Transactions',
          tabBarIcon: ({ color }) => <Icon name="list.bullet" color={color} />,
        }}
      />
      <Tabs.Screen
        name="budget"
        options={{
          title: 'Budget',
          tabBarIcon: ({ color }) => <Icon name="chart.bar" color={color} />,
        }}
      />
    </Tabs>
  );
}
