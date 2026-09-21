import 'package:flutter/material.dart';

import 'app_state.dart';
import 'ui/home_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final state = AppState();
  state.init();
  runApp(WhoopApp(state));
}

class WhoopApp extends StatelessWidget {
  final AppState state;
  const WhoopApp(this.state, {super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'WHOOP companion',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF00C2A8), brightness: Brightness.dark, useMaterial3: true),
      home: HomePage(state),
    );
  }
}
