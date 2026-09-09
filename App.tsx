import { useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import Ionicons from '@expo/vector-icons/Ionicons'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { AuthProvider, useAuth } from './src/auth'
import LoginScreen from './src/screens/LoginScreen'
import ChatScreen from './src/screens/ChatScreen'
import HomeScreen from './src/screens/HomeScreen'
import KnowledgeScreen from './src/screens/KnowledgeScreen'
import SkillsScreen from './src/screens/SkillsScreen'
import type { RootStackParamList, MainTabParamList } from './src/types/navigation'

const Stack = createNativeStackNavigator<RootStackParamList>()
const Tab = createBottomTabNavigator<MainTabParamList>()

/** focused/outline 双态 tab 图标助手 */
function tabIcon(focusedName: string, outlineName: string) {
  return function TabIcon({ color, size, focused }: { color: string; size: number; focused: boolean }) {
    return <Ionicons name={(focused ? focusedName : outlineName) as any} size={size} color={color} />
  }
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#4d86ff',
        tabBarInactiveTintColor: '#8590a6',
        tabBarStyle: { backgroundColor: '#fff', borderTopColor: '#e4ebf7' },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarHideOnKeyboard: true,
        sceneStyle: { backgroundColor: '#fff' },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: '首页', tabBarIcon: tabIcon('home', 'home-outline') }}
      />
      <Tab.Screen
        name="Chat"
        component={ChatScreen}
        options={{ title: '聊天', tabBarIcon: tabIcon('chatbubble-ellipses', 'chatbubble-ellipses-outline') }}
      />
      <Tab.Screen
        name="Knowledge"
        component={KnowledgeScreen}
        options={{ title: '知识库', tabBarIcon: tabIcon('book', 'book-outline') }}
      />
      <Tab.Screen
        name="Skills"
        component={SkillsScreen}
        options={{ title: '技能', tabBarIcon: tabIcon('apps', 'apps-outline') }}
      />
    </Tab.Navigator>
  )
}

function Root() {
  const { user, ready, refreshUser } = useAuth()

  useEffect(() => {
    refreshUser()
  }, [refreshUser])

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#4d86ff" />
      </View>
    )
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#fff' },
        }}
      >
        {user ? (
          <Stack.Screen name="Main" component={MainTabs} />
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  )
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <Root />
      </AuthProvider>
    </SafeAreaProvider>
  )
}
