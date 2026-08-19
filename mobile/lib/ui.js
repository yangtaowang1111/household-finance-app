/* Shared pieces, so a screen describes what it shows rather than how to draw it.
 *
 * The list style deliberately mirrors iOS's own grouped-inset lists — the shape
 * Settings, Mail and Health all use. Matching it is most of what makes an app
 * feel native: a reader already knows how these behave before opening it. */

import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View, useColorScheme } from 'react-native';
import { colors, radius, space, type } from './theme';

export function useTheme() {
  return colors(useColorScheme());
}

/** A grouped-inset section: rounded card, hairline separators, optional header. */
export function Section({ title, footer, children }) {
  const c = useTheme();
  const items = Array.isArray(children) ? children.filter(Boolean) : [children];

  return (
    <View style={{ marginBottom: space.xl }}>
      {title ? (
        <Text
          style={{
            ...type.footnote,
            color: c.muted,
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            marginBottom: space.sm,
            marginLeft: space.sm,
          }}
        >
          {title}
        </Text>
      ) : null}

      <View style={{ backgroundColor: c.surface, borderRadius: radius.lg, overflow: 'hidden' }}>
        {items.map((child, i) => (
          <View key={i}>
            {i > 0 ? (
              <View style={{ height: 1, backgroundColor: c.lineSoft, marginLeft: space.lg }} />
            ) : null}
            {child}
          </View>
        ))}
      </View>

      {footer ? (
        <Text style={{ ...type.footnote, color: c.muted, marginTop: space.sm, marginHorizontal: space.sm }}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

/** One line in a section: a label, an optional subtitle, and a value. */
export function Row({ label, sub, value, valueColor, onPress }) {
  const c = useTheme();
  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: space.md,
        paddingHorizontal: space.lg,
        gap: space.md,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ ...type.body, color: c.text }} numberOfLines={1}>
          {label}
        </Text>
        {sub ? (
          <Text style={{ ...type.footnote, color: c.muted, marginTop: 1 }} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {value !== undefined ? (
        <Text style={{ ...type.body, ...type.figure, color: valueColor || c.muted }}>{value}</Text>
      ) : null}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      {body}
    </Pressable>
  );
}

/** The one figure a screen is actually about. */
export function Hero({ label, value, delta, deltaColor }) {
  const c = useTheme();
  return (
    <View style={{ marginBottom: space.xl }}>
      <Text style={{ ...type.footnote, color: c.muted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {label}
      </Text>
      <Text style={{ ...type.largeTitle, ...type.figure, color: c.text, marginTop: space.xs }}>
        {value}
      </Text>
      {delta ? (
        <Text style={{ ...type.subhead, ...type.figure, color: deltaColor || c.muted, marginTop: 2 }}>
          {delta}
        </Text>
      ) : null}
    </View>
  );
}

/** A screen body: pull-to-refresh, consistent insets, loading and error states. */
export function Screen({ loading, error, onRefresh, children }) {
  const c = useTheme();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
        <ActivityIndicator color={c.muted} />
      </View>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
      refreshControl={onRefresh ? <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={c.muted} /> : undefined}
    >
      {error ? (
        <View
          style={{
            backgroundColor: c.attnSoft,
            borderRadius: radius.md,
            padding: space.lg,
            marginBottom: space.lg,
          }}
        >
          <Text style={{ ...type.subhead, color: c.text }}>{error}</Text>
        </View>
      ) : null}
      {children}
    </ScrollView>
  );
}
