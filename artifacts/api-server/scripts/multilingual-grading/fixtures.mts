/** Synthetic translations, NOT independently reviewed candidate evidence. */
export const fixtures = [
  {
    locale: "en-US",
    question: "Describe how you improved a slow API.",
    substantive:
      "Our search API had p95 latency of 2.4 seconds. I used flame graphs and found N+1 permission checks taking 60% of the time. I batched them with Redis MGET and added a 30-second permission cache. p95 fell to 320 milliseconds and infrastructure costs fell 18%.",
    thin: "I investigated performance issues and used best practices. Performance improved and stakeholders were happy.",
    refusal: "I don't know. I haven't worked on API performance.",
  },
  {
    locale: "hi",
    question: "बताइए कि आपने धीमे API का प्रदर्शन कैसे सुधारा।",
    substantive:
      "हमारे सर्च API की p95 लेटेंसी 2.4 सेकंड थी। मैंने फ्लेम ग्राफ से देखा कि N+1 अनुमति जाँच में 60% समय लग रहा था। मैंने Redis MGET से जाँच को बैच किया और 30 सेकंड का अनुमति कैश जोड़ा। p95 घटकर 320 मिलीसेकंड हो गई और इंफ्रास्ट्रक्चर लागत 18% कम हुई।",
    thin: "मैंने प्रदर्शन की समस्याओं की जाँच की और सर्वोत्तम तरीकों का इस्तेमाल किया। प्रदर्शन सुधरा और संबंधित लोग खुश थे।",
    refusal: "मुझे नहीं पता। मैंने API के प्रदर्शन पर काम नहीं किया है।",
  },
  {
    locale: "te",
    question: "నెమ్మదిగా ఉన్న API పనితీరును మీరు ఎలా మెరుగుపరిచారో వివరించండి.",
    substantive:
      "మా సెర్చ్ APIలో p95 లేటెన్సీ 2.4 సెకన్లు ఉండేది. ఫ్లేమ్ గ్రాఫ్‌లతో పరిశీలిస్తే N+1 అనుమతి తనిఖీలకు 60% సమయం పడుతోందని తెలిసింది. Redis MGETతో వాటిని బ్యాచ్ చేసి, 30 సెకన్ల అనుమతి క్యాష్‌ను జోడించాను. p95 లేటెన్సీ 320 మిల్లీసెకన్లకు తగ్గింది, మౌలిక సదుపాయాల ఖర్చు 18% తగ్గింది.",
    thin: "పనితీరు సమస్యలను పరిశీలించి ఉత్తమ పద్ధతులు ఉపయోగించాను. పనితీరు మెరుగుపడింది, సంబంధిత వ్యక్తులు సంతోషించారు.",
    refusal: "నాకు తెలియదు. API పనితీరుపై నేను పని చేయలేదు.",
  },
  {
    locale: "ta",
    question: "மெதுவான APIயின் செயல்திறனை எப்படி மேம்படுத்தினீர்கள் என்று விளக்குங்கள்.",
    substantive:
      "எங்கள் தேடல் APIயின் p95 தாமதம் 2.4 வினாடிகள் இருந்தது. ஃபிளேம் கிராஃப்களைப் பயன்படுத்தி N+1 அனுமதிச் சோதனைகள் 60% நேரத்தை எடுத்ததை கண்டறிந்தேன். Redis MGET மூலம் அவற்றை தொகுத்து, 30 வினாடி அனுமதி கேஷைச் சேர்த்தேன். p95 தாமதம் 320 மில்லிவினாடிகளாக குறைந்தது; உள்கட்டமைப்பு செலவு 18% குறைந்தது.",
    thin: "செயல்திறன் பிரச்சினைகளை ஆராய்ந்து சிறந்த நடைமுறைகளைப் பயன்படுத்தினேன். செயல்திறன் மேம்பட்டது, சம்பந்தப்பட்டவர்கள் மகிழ்ந்தனர்.",
    refusal: "எனக்குத் தெரியாது. API செயல்திறனில் நான் வேலை செய்ததில்லை.",
  },
  {
    locale: "bn",
    question: "একটি ধীর API-এর কার্যক্ষমতা কীভাবে উন্নত করেছিলেন তা বলুন।",
    substantive:
      "আমাদের সার্চ API-এর p95 লেটেন্সি ছিল 2.4 সেকেন্ড। ফ্লেম গ্রাফ ব্যবহার করে দেখলাম N+1 অনুমতি যাচাইয়ে 60% সময় লাগছে। Redis MGET দিয়ে যাচাইগুলো একসঙ্গে করলাম এবং 30 সেকেন্ডের অনুমতি ক্যাশ যোগ করলাম। p95 কমে 320 মিলিসেকেন্ড হলো এবং অবকাঠামোর খরচ 18% কমল।",
    thin: "কার্যক্ষমতার সমস্যা পরীক্ষা করেছি এবং ভালো পদ্ধতি ব্যবহার করেছি। কার্যক্ষমতা বেড়েছে এবং সংশ্লিষ্ট ব্যক্তিরা খুশি হয়েছেন।",
    refusal: "আমি জানি না। API-এর কার্যক্ষমতা নিয়ে আমি কাজ করিনি।",
  },
  {
    locale: "kn",
    question: "ನಿಧಾನವಾಗಿದ್ದ API ಕಾರ್ಯಕ್ಷಮತೆಯನ್ನು ಹೇಗೆ ಸುಧಾರಿಸಿದಿರಿ ಎಂದು ವಿವರಿಸಿ.",
    substantive:
      "ನಮ್ಮ ಸರ್ಚ್ APIಯ p95 ವಿಳಂಬ 2.4 ಸೆಕೆಂಡುಗಳಾಗಿತ್ತು. ಫ್ಲೇಮ್ ಗ್ರಾಫ್‌ಗಳಿಂದ N+1 ಅನುಮತಿ ಪರಿಶೀಲನೆಗಳು 60% ಸಮಯ ತೆಗೆದುಕೊಳ್ಳುತ್ತಿದ್ದವು ಎಂದು ಕಂಡೆ. Redis MGET ಬಳಸಿ ಅವುಗಳನ್ನು ಬ್ಯಾಚ್ ಮಾಡಿ, 30 ಸೆಕೆಂಡುಗಳ ಅನುಮತಿ ಕ್ಯಾಶ್ ಸೇರಿಸಿದೆ. p95 ವಿಳಂಬ 320 ಮಿಲಿಸೆಕೆಂಡುಗಳಿಗೆ ಇಳಿಯಿತು ಮತ್ತು ಮೂಲಸೌಕರ್ಯ ವೆಚ್ಚ 18% ಕಡಿಮೆಯಾಯಿತು.",
    thin: "ಕಾರ್ಯಕ್ಷಮತೆಯ ಸಮಸ್ಯೆಗಳನ್ನು ಪರಿಶೀಲಿಸಿ ಉತ್ತಮ ವಿಧಾನಗಳನ್ನು ಬಳಸಿದೆ. ಕಾರ್ಯಕ್ಷಮತೆ ಸುಧಾರಿಸಿತು ಮತ್ತು ಸಂಬಂಧಪಟ್ಟವರು ಸಂತೋಷಪಟ್ಟರು.",
    refusal: "ನನಗೆ ಗೊತ್ತಿಲ್ಲ. API ಕಾರ್ಯಕ್ಷಮತೆಯ ಮೇಲೆ ನಾನು ಕೆಲಸ ಮಾಡಿಲ್ಲ.",
  },
  {
    locale: "mr",
    question: "संथ API ची कामगिरी कशी सुधारली ते सांगा.",
    substantive:
      "आमच्या सर्च API ची p95 लेटन्सी 2.4 सेकंद होती. फ्लेम ग्राफ वापरून N+1 परवानगी तपासण्यांत 60% वेळ जात असल्याचे दिसले. Redis MGET वापरून त्या एकत्र केल्या आणि 30 सेकंदांचा परवानगी कॅश जोडला. p95 लेटन्सी 320 मिलिसेकंदांवर आली आणि पायाभूत सुविधांचा खर्च 18% कमी झाला.",
    thin: "कामगिरीच्या समस्या तपासून सर्वोत्तम पद्धती वापरल्या. कामगिरी सुधारली आणि संबंधित लोक समाधानी झाले.",
    refusal: "मला माहीत नाही. मी API च्या कामगिरीवर काम केलेले नाही.",
  },
  {
    locale: "es-ES",
    question: "Describe cómo mejoraste el rendimiento de una API lenta.",
    substantive:
      "Nuestra API de búsqueda tenía una latencia p95 de 2.4 segundos. Usé gráficos de llamas y descubrí que las comprobaciones de permisos N+1 consumían el 60% del tiempo. Las agrupé con Redis MGET y añadí una caché de permisos de 30 segundos. El p95 bajó a 320 milisegundos y el coste de infraestructura cayó un 18%.",
    thin: "Investigué los problemas de rendimiento y apliqué buenas prácticas. El rendimiento mejoró y las partes interesadas quedaron satisfechas.",
    refusal: "No lo sé. No he trabajado en el rendimiento de APIs.",
  },
  {
    locale: "ar",
    question: "صف كيف حسّنت أداء واجهة API بطيئة.",
    substantive:
      "كان زمن الاستجابة p95 لواجهة البحث لدينا 2.4 ثانية. استخدمت مخططات اللهب واكتشفت أن فحوص الصلاحيات N+1 تستغرق 60% من الوقت. جمعتها باستخدام Redis MGET وأضفت ذاكرة مؤقتة للصلاحيات مدتها 30 ثانية. انخفض p95 إلى 320 ملي ثانية وانخفضت تكلفة البنية التحتية 18%.",
    thin: "درست مشاكل الأداء واستخدمت أفضل الممارسات. تحسن الأداء وكان أصحاب المصلحة سعداء.",
    refusal: "لا أعرف. لم أعمل على تحسين أداء واجهات API.",
  },
  {
    locale: "fr",
    question: "Décrivez comment vous avez amélioré les performances d'une API lente.",
    substantive:
      "Notre API de recherche avait une latence p95 de 2.4 secondes. J'ai utilisé des flame graphs et découvert que les contrôles de permissions N+1 prenaient 60% du temps. Je les ai regroupés avec Redis MGET et ajouté un cache de permissions de 30 secondes. Le p95 est descendu à 320 millisecondes et les coûts d'infrastructure ont diminué de 18%.",
    thin: "J'ai étudié les problèmes de performance et appliqué les bonnes pratiques. Les performances se sont améliorées et les parties prenantes étaient satisfaites.",
    refusal: "Je ne sais pas. Je n'ai pas travaillé sur les performances des API.",
  },
] as const;

export type CaseKind = "substantive" | "thin" | "refusal" | "missing";
export const caseKinds: CaseKind[] = ["substantive", "thin", "refusal", "missing"];
