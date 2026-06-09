# Sound Design Reference

Use this when adjusting synthesizer, sampler, or FX parameters to sculpt a sound.

---

## The ADSR Envelope → Tone Shape

| Stage | Low value | High value |
|---|---|---|
| **Attack** | Punchy, clicking transient | Soft, slow fade-in (pad-like) |
| **Decay** | Bright snap, transient-heavy | Long bloom, slow body fade |
| **Sustain** | Percussive (volume drops fast) | Full, held note body |
| **Release** | Choppy, staccato, short tail | Long bloom, reverb-like tail |

---

## Filter Parameters → Brightness / Darkness

| Parameter | Low value | High value |
|---|---|---|
| **Cutoff / Frequency** | Dark, warm, muffled | Bright, open, airy, harsh |
| **Resonance / Q** | Natural, smooth | Metallic, nasal, ringing peak at cutoff |
| **Filter Type** | — | LP=warm, HP=thin, BP=nasal, Notch=hollow |

---

## LFO → Movement / Modulation

- **Rate**: Slow = gentle movement / breath. Fast = vibrato / tremolo.
- **Depth / Amount**: Low = subtle. High = dramatic wobble or pitch vibrato.
- **LFO to Cutoff**: Creates filter-wobble (wah-like) or gentle filter breath.
- **LFO to Pitch**: Creates vibrato. Amount should be small (1–5 semitones max for musical effect).

---

## Common Sound Descriptions → Parameter Strategy

### "Warm"
- Lower Filter Cutoff to 30–50% of max
- Slight Resonance reduction
- Slower Attack (20–60ms), longer Release (300–600ms)
- High Sustain level

### "Bright / Crisp"
- Higher Filter Cutoff (70–100% of max)
- Medium Resonance for character
- Fast Attack (<10ms), medium Decay
- Avoid excess low-end — reduce low-frequency content

### "Punchy / Tight"
- Very fast Attack (<5ms), fast Decay (50–150ms)
- Low Sustain, short Release
- Boost presence around 2–5kHz if available
- Compressor: medium attack (30ms), fast release

### "Dark / Heavy"
- Very low Filter Cutoff (15–30% of max)
- Moderate-to-high Resonance for definition
- Slow Decay, long Release

### "Dusty / Gritty / Lo-fi"
- Reduce Filter Cutoff significantly
- Add Saturator Drive (low-to-medium — avoid distortion)
- Slight Bitcrusher if available (Downsample to 12–14 bit range)
- Reduce high-frequency content

### "Airy / Ethereal"
- Long Attack (200–800ms)
- Long Release (600–2000ms)
- High Filter Cutoff, low Resonance
- Increase Reverb Wet and Decay Time
- High Sustain

### "Pluck / Pizzicato"
- Very fast Attack (<2ms), fast Decay (100–300ms)
- Low or zero Sustain
- Short Release

### "Pad / Lush"
- Slow Attack (300–800ms)
- High Sustain, long Release (800–2000ms)
- Medium Filter Cutoff, low Resonance
- Reverb: large room, high Wet

### "Metallic / Bell-like"
- Very fast Attack, medium-to-long Decay
- Zero Sustain, medium Release
- High Filter Cutoff or no filter
- Consider FM ratio adjustment if Operator

### "Sub / Deep"
- No filter (fully open)
- Long Attack, long Release
- No resonance
- Sine or triangle oscillator preferred

---

## FX Devices — Key Parameters

### Reverb
- **Decay Time**: Higher = bigger/longer space
- **Wet (Dry/Wet)**: Higher = more washed out; keep <40% for presence
- **Room Size / Diffusion**: Higher = more diffuse/smooth

### Delay (Echo / Delay)
- **Delay Time**: Use musical values — sync to host BPM when possible
- **Feedback**: Higher = more repeats (keep <80% to avoid runaway)
- **Wet**: Keep low (15–30%) for subtle effect, higher for echo-forward mix

### Compressor
- **Threshold**: Lower = more compression triggered
- **Ratio**: 2:1=gentle, 4:1=medium, 8:1+=heavy
- **Attack**: Fast (1ms) = tames transients. Slow (30ms) = lets punch through
- **Release**: Fast = pumping. Slow = smoother

### Saturator
- **Drive**: More = warmer/grittier harmonics
- **Type**: Analog Clip, Soft Sine, Waveshaper, Fold — each has different character
- **Wet/Dry**: Use Dry/Wet to blend in saturation without over-driving

### Auto Filter
- **Frequency**: The cutoff sweep position
- **Resonance**: Peak at cutoff — adds character

### EQ Eight
- Band Gain: + = boost, - = cut
- Frequency: Which frequency is affected
- Q: Width of the band (high Q = narrow/surgical)

---

## Ableton Simpler — Key Parameters

- **Start / End**: Sample playback region within the file
- **Fade In / Fade Out**: Crossfade at loop boundaries
- **Filter Freq, Filter Type, Filter Q**: Built-in filter on the sample
- **Volume Envelope A/D/S/R**: Amplitude envelope
- **Pan**: Stereo position
- **Detune / Transpose**: Pitch adjustment

---

## Best Practices

1. **Work holistically** — envelope + filter + FX together determine the feel.
2. **Don't over-compress** — leave headroom; compression is one tool, not a fix-all.
3. **Reverb last** in the chain; saturator before reverb for a richer tail.
4. **Less is more** for subtle adjustments — small moves have large effects on tone.
5. **Trust the range** — never set values outside [min, max]; clamp to the boundary.
