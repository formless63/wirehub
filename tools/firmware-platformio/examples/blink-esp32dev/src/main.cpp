// Synthetic example: blink an LED. LED_PIN and BLINK_MS come from the project configuration.
#include <Arduino.h>
#ifndef LED_PIN
#define LED_PIN 2
#endif
#ifndef BLINK_MS
#define BLINK_MS 500
#endif
void setup() { pinMode(LED_PIN, OUTPUT); }
void loop() { digitalWrite(LED_PIN, !digitalRead(LED_PIN)); delay(BLINK_MS); }
