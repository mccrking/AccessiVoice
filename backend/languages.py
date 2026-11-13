"""Explicit command vocabulary, not a trained English/Darija language model.

Match complete utterances only. Unknown, negative and compound requests must
never become sensitive actions through a keyword or partial-match fallback.
"""
import re
import unicodedata


def normalize_command(text):
    text = unicodedata.normalize('NFKD', text.casefold()).replace('ـ', '')
    text = ''.join(c for c in text if not unicodedata.combining(c))
    text = text.translate(str.maketrans({'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ى': 'ي'}))
    return ' '.join(''.join(c if c.isalnum() else ' ' for c in text).split())


COMMANDS = {
    'en': {
        'home': ['home', 'go home', 'open my space', 'open my dashboard', 'back to home'],
        'documents': ['my documents', 'open my documents', 'show my documents', 'I want my documents', 'view my documents'],
        'grades': ['my grades', 'my marks', 'open my grades', 'show my grades', 'show me my grades', 'I want my grades', 'view my results', 'show my results'],
        'forms': ['open the form', 'open my requests', 'my requests', 'open my procedures', 'I want a certificate', 'request a certificate'],
        'help': ['help', 'help me', 'show help', 'what can you do'],
        'read': ['read', 'read this page', 'read the page', 'read aloud', 'read this aloud'],
        'pause': ['pause', 'pause reading', 'stop reading', 'pause the reading'],
        'resume': ['resume', 'resume reading', 'continue reading', 'keep reading'],
        'repeat': ['repeat', 'repeat that', 'say that again', 'repeat the answer'],
        'slower': ['slower', 'speak slower', 'read slower', 'slow down', 'speak more slowly'],
        'next_field': ['next field', 'go to the next field', 'select the next field'],
        'download': ['download my certificate', 'download the certificate', 'download my enrollment certificate', 'download my school certificate'],
        'submit': ['submit the form', 'send the form', 'submit my request', 'send my request'],
        'confirm': ['I confirm', 'confirm', 'confirm this action', 'yes I confirm'],
        'cancel': ['cancel', 'cancel this action', 'cancel my request', 'no', 'no cancel'],
    },
    'ary': {
        'home': ['رجع للرئيسية', 'رجعني للرئيسية', 'حل الصفحة الرئيسية', 'rje3 l accueil', 'rje3 laccueil', 'rje3 l page principale'],
        'documents': ['الوثائق ديالي', 'حل الوثائق ديالي', 'وريني الوثائق ديالي', 'بغيت الوثائق ديالي', '7ell l wta2i9 dyali', '7el wta2i9 dyali', 'werini documents dyali', 'bghit documents dyali', '7ell documents dyali'],
        'grades': ['النقط ديالي', 'نقطي', 'حل النقط ديالي', 'وريني النقط ديالي', 'بغيت نشوف النقط ديالي', 'بغيت النقط ديالي', '7ell no9at dyali', '7el no9at dyali', 'werini no9at dyali', 'bghit nchof no9at dyali', 'bghit no9at dyali', 'no9at dyali', 'werini les notes dyali'],
        'forms': ['حل الاستمارة', 'حل الفورمولير', 'بغيت شهادة مدرسية', 'بغيت ندير طلب', '7ell formulaire', '7el formulaire', 'bghit chahada madrassia', 'bghit ndir talab'],
        'help': ['عاونّي', 'عاوني', 'بغيت المساعدة', 'شنو كتقدر دير', '3awni', 'bghit l mosa3ada', 'chno kat9der dir'],
        'read': ['قرا ليا هاد الصفحة', 'قرا ليا الصفحة', 'قرا هاد الصفحة', '9ra lia had saf7a', '9ra lia saf7a', '9ra lia had page'],
        'pause': ['وقف القراية', 'حبس القراية', 'حبس القراءة', '7bes l9raya', '7bes l 9raya', 'we9ef l9raya'],
        'resume': ['كمل القراية', 'كمل القراءة', 'كمل قرا', 'kemmel l9raya', 'kemmel l 9raya', 'kemmel 9ra'],
        'repeat': ['عاود', 'عاود ليا', 'عاود الجواب', '3awed', '3awed lia', '3awed ljawab'],
        'slower': ['قرا بشوية', 'هضر بشوية', 'بشوية', '9ra bchwia', 'hder bchwia', 'bchwia'],
        'next_field': ['الخانة الجاية', 'دوز للخانة الجاية', 'دوز للخانة الموالية', 'دوز للشامب الجاي', 'دوز للتالي', 'doz l champ jaya', 'doz l champ jاي', 'doz lkhana jaya', 'lkhana jaya', 'champ suivant'],
        'download': ['حمل الشهادة المدرسية', 'نزل الشهادة المدرسية', 'تيليشارجي الشهادة', 'حمل شهادة مدرسية', '7emmel chahada madrassia', 'telechargi chahada', 'telecharge attestation dyali'],
        'submit': ['صيفط الاستمارة', 'صيفط الفورمولير', 'صيفط الطلب ديالي', 'sift formulaire', 'sift lformulaire', 'sift talab dyali'],
        'confirm': ['كنأكد', 'أنا كنأكد', 'اكد هاد العملية', 'كنوافق', 'kan2aked', 'kan aked', 'ana kan2aked', 'kanwafe9'],
        'cancel': ['لغي', 'لغي الطلب', 'لغي هاد العملية', 'بلاش', 'لا', 'خليها', 'lghi', 'lghi talab', 'bla', 'blach', 'la', 'khliha'],
    },
}

LOOKUP = {language: {normalize_command(text): intent for intent, texts in intents.items() for text in texts} for language, intents in COMMANDS.items()}


def multilingual_decision(text, language=None):
    clean = normalize_command(text)
    for key in ([language] if language else LOOKUP):
        vocabulary = LOOKUP.get(key, {})
        # Politeness may wrap ordinary commands, never an ambiguous confirmation.
        intent = vocabulary.get(clean)
        if intent:
            return intent, 1.0
        if key == 'en':
            polite = re.sub(r'^(?:please |can you |could you )', '', clean)
            polite = re.sub(r' please$', '', polite)
        else:
            polite = re.sub(r'^(?:عافاك |الله يخليك |3afak |afak )', '', clean)
            polite = re.sub(r' (?:عافاك|3afak|afak)$', '', polite)
        intent = vocabulary.get(polite)
        if intent and intent not in {'confirm', 'cancel'}:
            return intent, 1.0
    return None


def blocked_multilingual(text):
    clean = normalize_command(text)
    return bool(re.search(r'\b(don t|dont|do not|not|never|without|maybe|perhaps|delete|remove|buy|pay|email|and|then|or|machi|mat|bla ma|لا|ما|ماتصيفطش|متصيفطش|ماتحملش|متحملش|بلا|يمكن|مسح|خلص|شري)\b', clean))
