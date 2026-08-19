from gtts import gTTS
import os

# Define the script text divided into three punchy sections
text = (
    "Did you know that after age thirty, you lose up to five percent of your muscle mass every single decade? "
    "This loss leads directly to physical frailty, a crashing metabolic rate, and high risk of serious injury. "
    "But there is a cure: strength training. Lifting weights reverses muscle loss and keeps you strong. "
    "Start lifting today!"
)

# Initialize gTTS with the voiceover script
tts = gTTS(text=text, lang='en', slow=False)

# Ensure the output directory exists
os.makedirs("public/assets", exist_ok=True)

# Save the generated audio file
output_path = "public/assets/vo_muscle_loss.mp3"
tts.save(output_path)

print(f"Voiceover track generated successfully at: {output_path}")
