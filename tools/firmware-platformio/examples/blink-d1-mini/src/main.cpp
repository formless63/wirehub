// Synthetic example: blink an LED and print the configured name over serial.
#include <Arduino.h>

#ifndef LED_PIN
#define LED_PIN LED_BUILTIN
#endif
#ifndef BLINK_MS
#define BLINK_MS 500
#endif
#ifndef DEVICE_NAME
#define DEVICE_NAME "blink"
#endif

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  Serial.println(DEVICE_NAME);
}

void loop() {
  digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  delay(BLINK_MS);
}
