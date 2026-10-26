/** Provider locale snapshots, verified 2026-10-24.
 * Sources: Brave web/search API reference; SerpAPI google-countries and
 * google-languages; Tavily search OpenAPI country enum. See docs/web-search-filters.md.
 * Keep vendor values: canonicalization and aliases belong in search-filters.ts.
 */
export const BRAVE_COUNTRIES = ["AR", "AU", "AT", "BE", "BR", "CA", "CL", "DK", "FI", "FR", "DE", "GR", "HK", "IN", "ID", "IT", "JP", "KR", "MY", "MX", "NL", "NZ", "NO", "CN", "PL", "PT", "PH", "RU", "SA", "ZA", "ES", "SE", "CH", "TW", "TR", "GB", "US"] as const
export const BRAVE_LANGUAGES = ["ar", "eu", "bn", "bg", "ca", "zh-hans", "zh-hant", "hr", "cs", "da", "nl", "en", "en-gb", "et", "fi", "fr", "gl", "de", "el", "gu", "he", "hi", "hu", "is", "it", "ja", "jp", "kn", "ko", "lv", "lt", "ms", "ml", "mr", "nb", "pl", "pt-br", "pt-pt", "pa", "ro", "ru", "sr", "sk", "sl", "es", "sv", "ta", "te", "th", "tr", "uk", "vi"] as const
export const GOOGLE_COUNTRIES = `
  af al dz as ad ao ai aq ag ar am aw au at az bs
  bh bd bb by be bz bj bm bt bo ba bw bv br io bn
  bg bf bi kh cm ca cv ky cf td cl cn cx cc co km
  cg cd ck cr ci hr cu cy cz dk dj dm do ec eg sv
  gq er ee et fk fo fj fi fr gf pf tf ga gm ge de
  gh gi gr gl gd gp gu gt gg gn gw gy ht hm va hn
  hk hu is in id ir iq ie im il it je jm jp jo kz
  ke ki kp kr kw kg la lv lb ls lr ly li lt lu mo
  mk mg mw my mv ml mt mh mq mr mu yt mx fm md mc
  mn me ms ma mz mm na nr np nl an nc nz ni ne ng
  nu nf mp no om pk pw ps pa pg py pe ph pn pl pt
  pr qa re ro ru rw sh kn lc pm vc ws sm st sa sn
  rs sc sl sg sk si sb so za gs es lk sd sr sj sz
  se ch sy tw tj tz th tl tg tk to tt tn tr tm tc
  tv ug ua ae uk gb us um uy uz vu ve vn vg vi wf
  eh ye zm zw
`.trim().split(/\s+/)

export const GOOGLE_LANGUAGES = `
  af ak sq ws am ar hy az eu be bem bn bh bs br bg
  bt km ca chr ny co hr cs da nl en eo et ee fo tl
  fi fr fy gaa gl ka de el kl gn gu ht ha haw iw he
  hi hu is ig id ia ga it ja jw kn kk rw rn kg ko
  kri ku ckb ky lo la lv ln lt loz lg ach mk mg ms ml
  mt mv mi mr mfe mo mn my ne pcm nso no nn oc or om
  ps fa pl pt pa qu ro rm nyn ru gd sr sh st tn crs
  sn sd si sk sl so es su sw sv tg ta tt te th ti
  to lua tum tr tk tw ug uk ur uz vu vi cy wo xh yi
  yo zu af-na af-za am-et ar-001 ar-ae ar-bh ar-dj ar-dz ar-eg ar-eh ar-er ar-il ar-iq ar-jo
  ar-km ar-kw ar-lb ar-ly ar-ma ar-mr ar-om ar-ps ar-qa ar-sa ar-sd ar-so ar-ss ar-sy ar-td ar-tn
  ar-ye as-in az-az be-by bg-bg bn-bd bn-in bo-cn bo-in br-fr bs-ba ca-ad ca-es ca-fr ca-it ccp-bd
  ccp-in ceb-ph chr-us ckb-iq ckb-ir co-fr cs-cz cy-gb da-dk da-gl de-at de-be de-ch de-de de-it de-li
  de-lu ee-gh ee-tg el-cy el-gr en-001 en-150 en-ad en-ae en-ag en-ai en-al en-ar en-as en-at en-au
  en-ba en-bb en-bd en-be en-bg en-bi en-bm en-br en-bs en-bw en-bz en-ca en-cc en-ch en-ck en-cl
  en-cm en-cn en-co en-cx en-cy en-cz en-de en-dg en-dk en-dm en-ee en-er en-es en-fi en-fj en-fk
  en-fm en-fr en-gb en-gd en-gg en-gh en-gi en-gm en-gr en-gu en-gy en-hk en-hr en-hu en-id en-ie
  en-il en-im en-in en-io en-is en-it en-je en-jm en-jp en-ke en-ki en-kn en-kr en-ky en-lc en-lr
  en-ls en-lt en-lu en-lv en-me en-mg en-mh en-mm en-mo en-mp en-ms en-mt en-mu en-mv en-mw en-mx
  en-my en-na en-nf en-ng en-nl en-no en-nr en-nu en-nz en-pg en-ph en-pk en-pl en-pn en-pr en-pt
  en-pw en-ro en-rs en-ru en-rw en-sa en-sb en-sc en-sd en-se en-sg en-sh en-si en-sk en-sl en-ss
  en-sx en-sz en-tc en-th en-tk en-to en-tr en-tt en-tv en-tw en-tz en-ua en-ug en-um en-us en-vc
  en-vg en-vi en-vu en-ws en-za en-zm en-zw eo-001 es-419 es-ag es-ai es-ar es-aw es-bb es-bl es-bm
  es-bo es-bq es-br es-bs es-bz es-ca es-cl es-co es-cr es-cu es-cw es-dm es-do es-ea es-ec es-es
  es-fk es-gd es-gf es-gl es-gp es-gq es-gt es-gy es-hn es-ht es-ic es-kn es-ky es-lc es-mf es-mq
  es-ms es-mx es-ni es-pa es-pe es-ph es-pm es-pr es-py es-sr es-sv es-sx es-tc es-tt es-us es-uy
  es-vc es-ve es-vg es-vi et-ee eu-es fa-af fa-ir fi-fi fil-ph fo-dk fo-fo fr-be fr-bf fr-bi fr-bj
  fr-bl fr-ca fr-cd fr-cf fr-cg fr-ch fr-ci fr-cm fr-dj fr-dz fr-fr fr-ga fr-gf fr-gn fr-gp fr-gq
  fr-ht fr-km fr-lu fr-ma fr-mc fr-mf fr-mg fr-ml fr-mq fr-mr fr-mu fr-nc fr-ne fr-pf fr-pm fr-re
  fr-rw fr-sc fr-sn fr-sy fr-td fr-tg fr-tn fr-vu fr-wf fr-yt fy-nl ga-ie gaa-gh gd-gb gl-es gn-py
  gsw-ch gsw-fr gsw-li gu-in ha-gh ha-ne ha-ng haw-us he-il hi-in hr-ba hr-hr hu-hu hy-am id-id ig-ng
  is-is it-ch it-it it-sm it-va ja-jp jv-id ka-ge kk-kz km-kh kn-in ko-kp ko-kr ku-tr ky-kg lb-lu
  lg-ug ln-ao ln-cd ln-cf ln-cg lo-la lv-lv mfe-mu mg-mg mi-nz mk-mk ml-in mn-mn mr-in ms-bn ms-my
  ms-sg mt-mt my-mm nb-no nb-sj ne-in ne-np nl-aw nl-be nl-bq nl-cw nl-nl nl-sr nl-sx nn-no nso-za
  ny-mw nyn-ug oc-fr om-et om-ke or-in pa-in pl-pl ps-af ps-pk pt-ao pt-br pt-ch pt-cv pt-fr pt-gq
  pt-gw pt-lu pt-mo pt-mz pt-pt pt-st pt-tl qu-bo qu-ec qu-pe rm-ch rn-bi ro-md ro-ro ru-by ru-kg
  ru-kz ru-md ru-ru ru-ua rw-rw sa-in scn-it sd-pk se-fi si-lk sk-sk sl-si sn-zw so-dj so-et so-ke
  so-so sq-al sq-mk sq-xk sr-ba sr-me sr-rs sr-xk st-ls st-za sv-ax sv-fi sv-se sw-cd sw-ke sw-tz
  sw-ug ta-in ta-lk ta-my ta-sg te-in tg-tj th-th ti-er ti-et tk-tm tn-bw tn-za to-to tr-cy tr-tr
  tt-ru ug-cn uk-ua ur-in ur-pk uz-uz vi-vn wo-sn xh-za yi-001 yo-bj yo-ng yue-cn yue-hk zh-cn zh-hk
  zh-mo zh-sg zh-tw zu-za
`.trim().split(/\s+/)

export const TAVILY_COUNTRIES: Readonly<Record<string, string>> = {
  "AF": "afghanistan",
  "AL": "albania",
  "DZ": "algeria",
  "AD": "andorra",
  "AO": "angola",
  "AR": "argentina",
  "AM": "armenia",
  "AU": "australia",
  "AT": "austria",
  "AZ": "azerbaijan",
  "BS": "bahamas",
  "BH": "bahrain",
  "BD": "bangladesh",
  "BB": "barbados",
  "BY": "belarus",
  "BE": "belgium",
  "BZ": "belize",
  "BJ": "benin",
  "BT": "bhutan",
  "BO": "bolivia",
  "BA": "bosnia and herzegovina",
  "BW": "botswana",
  "BR": "brazil",
  "BN": "brunei",
  "BG": "bulgaria",
  "BF": "burkina faso",
  "BI": "burundi",
  "KH": "cambodia",
  "CM": "cameroon",
  "CA": "canada",
  "CV": "cape verde",
  "CF": "central african republic",
  "TD": "chad",
  "CL": "chile",
  "CN": "china",
  "CO": "colombia",
  "KM": "comoros",
  "CR": "costa rica",
  "HR": "croatia",
  "CU": "cuba",
  "CY": "cyprus",
  "CZ": "czech republic",
  "DK": "denmark",
  "DJ": "djibouti",
  "DO": "dominican republic",
  "EC": "ecuador",
  "EG": "egypt",
  "SV": "el salvador",
  "GQ": "equatorial guinea",
  "ER": "eritrea",
  "EE": "estonia",
  "ET": "ethiopia",
  "FJ": "fiji",
  "FI": "finland",
  "FR": "france",
  "GA": "gabon",
  "GM": "gambia",
  "GE": "georgia",
  "DE": "germany",
  "GH": "ghana",
  "GR": "greece",
  "GT": "guatemala",
  "GN": "guinea",
  "HT": "haiti",
  "HN": "honduras",
  "HU": "hungary",
  "IS": "iceland",
  "IN": "india",
  "ID": "indonesia",
  "IR": "iran",
  "IQ": "iraq",
  "IE": "ireland",
  "IL": "israel",
  "IT": "italy",
  "JM": "jamaica",
  "JP": "japan",
  "JO": "jordan",
  "KZ": "kazakhstan",
  "KE": "kenya",
  "KP": "north korea",
  "KR": "south korea",
  "KW": "kuwait",
  "KG": "kyrgyzstan",
  "LV": "latvia",
  "LB": "lebanon",
  "LS": "lesotho",
  "LR": "liberia",
  "LI": "liechtenstein",
  "LT": "lithuania",
  "LU": "luxembourg",
  "MK": "north macedonia",
  "MG": "madagascar",
  "MW": "malawi",
  "MY": "malaysia",
  "MV": "maldives",
  "ML": "mali",
  "MT": "malta",
  "MR": "mauritania",
  "MU": "mauritius",
  "MX": "mexico",
  "MD": "moldova",
  "MC": "monaco",
  "MN": "mongolia",
  "ME": "montenegro",
  "MA": "morocco",
  "MZ": "mozambique",
  "MM": "myanmar",
  "NA": "namibia",
  "NP": "nepal",
  "NL": "netherlands",
  "NZ": "new zealand",
  "NI": "nicaragua",
  "NE": "niger",
  "NG": "nigeria",
  "NO": "norway",
  "OM": "oman",
  "PK": "pakistan",
  "PA": "panama",
  "PG": "papua new guinea",
  "PY": "paraguay",
  "PE": "peru",
  "PH": "philippines",
  "PL": "poland",
  "PT": "portugal",
  "QA": "qatar",
  "RO": "romania",
  "RU": "russia",
  "RW": "rwanda",
  "SA": "saudi arabia",
  "SN": "senegal",
  "RS": "serbia",
  "SG": "singapore",
  "SK": "slovakia",
  "SI": "slovenia",
  "SO": "somalia",
  "ZA": "south africa",
  "ES": "spain",
  "LK": "sri lanka",
  "SD": "sudan",
  "SE": "sweden",
  "CH": "switzerland",
  "SY": "syria",
  "TW": "taiwan",
  "TJ": "tajikistan",
  "TZ": "tanzania",
  "TH": "thailand",
  "TG": "togo",
  "TT": "trinidad and tobago",
  "TN": "tunisia",
  "TR": "turkey",
  "TM": "turkmenistan",
  "UG": "uganda",
  "UA": "ukraine",
  "AE": "united arab emirates",
  "GB": "united kingdom",
  "US": "united states",
  "UY": "uruguay",
  "UZ": "uzbekistan",
  "VE": "venezuela",
  "VN": "vietnam",
  "YE": "yemen",
  "ZM": "zambia",
  "ZW": "zimbabwe"
}
