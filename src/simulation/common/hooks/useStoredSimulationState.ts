import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  readSharedValue,
  registerShareable,
  sameShape,
  stripShareParam,
} from "../utils/shareState";

/** Keadaan simulasi yang bertahan selama sesi dan ikut tertulis di tautan bagikan. */
export function useStoredSimulationState<T>(
  name: string,
  fallback: T,
  enabled = true,
): [T, Dispatch<SetStateAction<T>>] {
  const key = `math1729.simulation.v1.${name}`;
  const [value, setValue] = useState<T>(() => {
    if (!enabled) return fallback;
    // 1) Nilai dari tautan bagikan (?s=...) didahulukan, jika bentuknya cocok.
    const shared = readSharedValue(name);
    if (shared !== undefined && sameShape(shared, fallback)) return shared as T;
    // 2) Nilai terakhir pada sesi ini.
    try {
      const savedValue = window.sessionStorage.getItem(key);
      return savedValue === null ? fallback : (JSON.parse(savedValue) as T);
    } catch {
      return fallback;
    }
  });
  const valueRef = useRef(value);
  valueRef.current = value;

  // Daftarkan nilai agar tombol "Bagikan" dapat membuat tautan.
  useEffect(() => {
    if (!enabled) return;
    return registerShareable(name, () => valueRef.current);
  }, [enabled, name]);

  // Nilai dari tautan sudah terbaca (dan tersimpan ke sessionStorage di bawah).
  useEffect(() => {
    if (enabled) stripShareParam();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timeoutId = window.setTimeout(() => {
      try {
        window.sessionStorage.setItem(key, JSON.stringify(value));
      } catch {}
    }, 150);
    return () => window.clearTimeout(timeoutId);
  }, [enabled, key, value]);

  useEffect(() => {
    if (!enabled) return;
    const persistLatestValue = () => {
      try {
        window.sessionStorage.setItem(key, JSON.stringify(valueRef.current));
      } catch {}
    };
    window.addEventListener("pagehide", persistLatestValue);
    return () => {
      window.removeEventListener("pagehide", persistLatestValue);
      persistLatestValue();
    };
  }, [enabled, key]);

  return [value, setValue];
}
